// End-to-end tests against a real worker with a real database.
//
// The unit tests cover the arithmetic; these cover the things only a database can
// tell you - that the first-attempt rule actually holds, that a token cannot be
// spent twice, that the board comes back in the right order. They start the worker
// with `wrangler dev --local`, which runs the same runtime Cloudflare does, offline.
//
//     npm run test:service
//
// Skipped automatically when the worker cannot be started, so `npm test` stays
// runnable anywhere.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;

let worker = null;

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function startRound(round) {
  const { body } = await post("/round/start", { pack: round });
  return body.token;
}

/** A clean sweep: 19 x 100, the finisher, and the no-clues bonus. */
const PERFECT = 1900 + 400 + 400;

const ROUND = "sept-28";

/**
 * Play a round through the service.
 *
 * The reported time is near zero, because these run in milliseconds and the worker
 * refuses a round claiming to have taken longer than the token has existed. Weaker
 * scores are made by finding fewer, not by burning time - time earns nothing here.
 */
async function finish(round, player, name, overrides = {}) {
  const token = await startRound(round);
  return post("/round/finish", {
    token,
    player,
    name,
    right: 19,
    questions: 19,
    seconds: 1,
    clues: [],
    ...overrides,
  });
}

describe("the leaderboard service", { concurrency: false }, () => {
  before(async () => {
    rmSync(`${ROOT}.wrangler/state/v3/d1`, { recursive: true, force: true });
    const setup = spawn(
      `${ROOT}node_modules/.bin/wrangler`,
      ["d1", "execute", "quickfire-scores", "--local", "--file=schema.sql"],
      { cwd: ROOT, stdio: "ignore" }
    );
    await new Promise((resolve) => setup.on("exit", resolve));

    worker = spawn(
      `${ROOT}node_modules/.bin/wrangler`,
      // The signing secret is passed in rather than read from .dev.vars, so the tests
      // need no local setup and run the same way on a fresh checkout and in CI.
      [
        "dev",
        "--local",
        "--port",
        String(PORT),
        "--ip",
        "127.0.0.1",
        "--var",
        "SCORE_SECRET:a-secret-for-testing",
      ],
      { cwd: ROOT, stdio: "ignore", env: { ...process.env, CI: "1" } }
    );
    if (!(await waitForHealth())) {
      worker.kill("SIGTERM");
      worker = null;
      throw new Error("wrangler dev did not come up - is it installed?");
    }
  });

  after(() => {
    if (worker) worker.kill("SIGTERM");
  });

  test("a finished round comes back with a score and a place", async () => {
    const { status, body } = await finish(ROUND, "player-a", "Marc");
    assert.equal(status, 200);
    assert.equal(body.counted, true);
    assert.equal(body.score, PERFECT);
    assert.equal(body.you.rank, 1);
  });

  test("only the first attempt at a round counts", async () => {
    await finish(ROUND, "player-b", "Marc", { right: 5 });
    const second = await finish(ROUND, "player-b", "Marc");

    assert.equal(second.body.counted, false);
    assert.match(second.body.reason, /first attempt/);
    // The board still shows the weaker first attempt, which is the point of the rule.
    assert.equal(second.body.you.score, 500);
  });

  test("the board is ordered by score, best first", async () => {
    await finish(ROUND, "p1", "Low", { right: 3 });
    await finish(ROUND, "p3", "Middle", { right: 8 });

    const response = await fetch(`${BASE}/board?pack=${ROUND}&player=p3`);
    const body = await response.json();
    assert.equal(body.top[0].name, "Marc");
    assert.equal(body.top.at(-1).name, "Low");
    assert.ok(body.you.rank > 1);
  });

  test("on an equal score the quicker round is placed first", async () => {
    // The only thing the timer is for. Both of these score 700.
    await finish(ROUND, "slow-one", "Tortoise", { right: 7, seconds: 3 });
    await finish(ROUND, "fast-one", "Hare", { right: 7, seconds: 0 });

    const response = await fetch(`${BASE}/board?pack=${ROUND}`);
    const body = await response.json();
    const sevens = body.top.filter((row) => row.score === 700).map((row) => row.name);
    assert.deepEqual(sevens, ["Hare", "Tortoise"]);
  });

  test("a made-up score is recalculated, not believed", async () => {
    const token = await startRound(ROUND);
    const { status, body } = await post("/round/finish", {
      token,
      player: "cheat",
      name: "Cheat",
      right: 19,
      seconds: 1,
      clues: [],
      score: 9_999_999, // ignored - the worker works it out itself
      total: 9_999_999,
    });
    assert.equal(status, 200);
    assert.equal(body.score, PERFECT);
  });

  test("a token cannot be spent twice", async () => {
    const token = await startRound(ROUND);
    const payload = { token, player: "r1", name: "Replay", right: 19, seconds: 1, clues: [] };
    assert.equal((await post("/round/finish", payload)).status, 200);

    // Same round, new identity - the shape a faked board would take.
    const again = await post("/round/finish", { ...payload, player: "r2" });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already been submitted/);
  });

  test("a forged token is refused", async () => {
    const { status, body } = await post("/round/finish", {
      token: "bWFkZS11cA.bm90LWEtc2lnbmF0dXJl",
      player: "forger",
      name: "Forger",
      right: 19,
      seconds: 1,
      clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /does not check out/);
  });

  test("a round cannot have taken longer than it has existed", async () => {
    const token = await startRound(ROUND);
    const { status, body } = await post("/round/finish", {
      token, player: "liar", name: "Liar", right: 19, seconds: 9000, clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /longer than it has existed/);
  });

  test("an impossible round is refused", async () => {
    const token = await startRound(ROUND);
    const { status, body } = await post("/round/finish", {
      token, player: "x", name: "X", right: 20, seconds: 1, clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /20 found out of a round of 19/);
  });

  test("a round nobody has heard of is refused at the start", async () => {
    const { status, body } = await post("/round/start", { pack: "invented-round" });
    assert.equal(status, 400);
    assert.match(body.error, /unknown round/);
  });

  test("an empty board is an empty board, not an error", async () => {
    const response = await fetch(`${BASE}/board?pack=${ROUND}&player=never-played`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).you, null);
  });

  test("a name with angle brackets cannot smuggle markup onto the board", async () => {
    await finish(ROUND, "m1", "<script>alert(1)</script>Marc", { right: 2 });
    const response = await fetch(`${BASE}/board?pack=${ROUND}`);
    const body = await response.json();
    assert.equal(body.top.some((row) => row.name.includes("<")), false);
  });

  test("a blank name becomes Anonymous rather than an empty row", async () => {
    await finish(ROUND, "b1", "   ", { right: 1 });
    const response = await fetch(`${BASE}/board?pack=${ROUND}&player=b1`);
    assert.equal((await response.json()).you.name, "Anonymous");
  });

  test("the board comes back in one request", async () => {
    const response = await fetch(`${BASE}/boards?packs=${ROUND},never-played&player=player-a`);
    const { boards } = await response.json();
    assert.equal(boards[ROUND].leader.score, PERFECT);
    assert.equal(boards[ROUND].yourScore, PERFECT);
    // A round nobody has played still gets an entry, so the list has no holes.
    assert.deepEqual(boards["never-played"], { players: 0, leader: null, yourScore: null });
  });

  test("asking for no boards is refused rather than answered emptily", async () => {
    assert.equal((await fetch(`${BASE}/boards?packs=`)).status, 400);
  });

  test("the board is readable from the page, wherever it is served from", async () => {
    const response = await fetch(`${BASE}/board?pack=${ROUND}`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
