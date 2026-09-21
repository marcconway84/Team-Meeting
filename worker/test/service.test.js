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

async function startRound(pack) {
  const { body } = await post("/round/start", { pack });
  return body.token;
}

/** A clean sweep: 12 x 100, the finisher, 600s x 2, and the no-clues bonus. */
const PERFECT = 1200 + 250 + 1200 + 250;

/**
 * Play a round through the service.
 *
 * The clock always comes back full. That is not laziness - the worker refuses a
 * round claiming to have taken longer than the token has existed, so a test that ran
 * in milliseconds cannot claim to have spent nine minutes. Weaker scores are made by
 * getting fewer right, not by burning time.
 */
async function finish(pack, player, name, overrides = {}) {
  const token = await startRound(pack);
  return post("/round/finish", {
    token,
    player,
    name,
    right: 12,
    questions: 12,
    secondsLeft: 600,
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
    const { status, body } = await finish("mixed-bag", "player-a", "Marc");
    assert.equal(status, 200);
    assert.equal(body.counted, true);
    assert.equal(body.score, PERFECT);
    assert.equal(body.you.rank, 1);
    assert.equal(body.players, 1);
  });

  test("only the first attempt at a pack counts", async () => {
    await finish("film-and-tv", "player-b", "Marc", { right: 5 });
    const second = await finish("film-and-tv", "player-b", "Marc");

    assert.equal(second.body.counted, false);
    assert.match(second.body.reason, /first attempt/);
    // The board still shows the weaker first attempt, which is the point of the rule.
    assert.equal(second.body.you.score, 500);
    assert.equal(second.body.players, 1);
  });

  test("the board is ordered by score, best first", async () => {
    await finish("tech-and-the-web", "p1", "Low", { right: 3 });
    await finish("tech-and-the-web", "p2", "High");
    await finish("tech-and-the-web", "p3", "Middle", { right: 8 });

    const response = await fetch(`${BASE}/board?pack=tech-and-the-web&player=p3`);
    const body = await response.json();
    assert.deepEqual(
      body.top.map((row) => row.name),
      ["High", "Middle", "Low"]
    );
    assert.equal(body.you.rank, 2);
    assert.equal(body.players, 3);
  });

  test("equal scores share a place rather than being split by who was quicker", async () => {
    await finish("mixed-bag", "t1", "First", { right: 7 });
    await finish("mixed-bag", "t2", "Second", { right: 7 });
    const response = await fetch(`${BASE}/board?pack=mixed-bag&player=t2`);
    const body = await response.json();
    assert.equal(body.you.rank, 2, "both sit behind the perfect round, and level with each other");
  });

  test("a token cannot be spent twice", async () => {
    const token = await startRound("mixed-bag");
    const payload = { token, player: "r1", name: "Replay", right: 12, secondsLeft: 600, clues: [] };
    assert.equal((await post("/round/finish", payload)).status, 200);

    // Same round, new identity - the shape a faked board would take.
    const again = await post("/round/finish", { ...payload, player: "r2" });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already been submitted/);
  });

  test("a made-up score is recalculated, not believed", async () => {
    const token = await startRound("mixed-bag");
    const { status, body } = await post("/round/finish", {
      token,
      player: "cheat",
      name: "Cheat",
      right: 12,
      secondsLeft: 600,
      clues: [],
      score: 9_999_999, // ignored - the worker works it out itself
      total: 9_999_999,
    });
    assert.equal(status, 200);
    assert.equal(body.score, PERFECT);
  });

  test("a forged token is refused", async () => {
    const { status, body } = await post("/round/finish", {
      token: "bWFkZS11cA.bm90LWEtc2lnbmF0dXJl",
      player: "forger",
      name: "Forger",
      right: 12,
      secondsLeft: 600,
      clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /does not check out/);
  });

  test("a round cannot finish faster than it could have been played", async () => {
    const token = await startRound("mixed-bag");
    // Claims to have used nine and a half minutes, a moment after starting.
    const { status, body } = await post("/round/finish", {
      token, player: "quick", name: "Quick", right: 12, secondsLeft: 30, clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /sooner than it could have been played/);
  });

  test("an impossible round is refused", async () => {
    const token = await startRound("mixed-bag");
    const { status, body } = await post("/round/finish", {
      token, player: "x", name: "X", right: 13, secondsLeft: 600, clues: [],
    });
    assert.equal(status, 400);
    assert.match(body.error, /13 right out of a pack of 12/);
  });

  test("a pack nobody has heard of is refused at the start", async () => {
    const { status, body } = await post("/round/start", { pack: "invented-pack" });
    assert.equal(status, 400);
    assert.match(body.error, /unknown pack/);
  });

  test("an empty board is an empty board, not an error", async () => {
    const response = await fetch(`${BASE}/board?pack=film-and-tv`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.you, null);
  });

  test("a name with angle brackets cannot smuggle markup onto the board", async () => {
    await finish("film-and-tv", "m1", "<script>alert(1)</script>Marc", { right: 2 });
    const response = await fetch(`${BASE}/board?pack=film-and-tv`);
    const body = await response.json();
    assert.equal(body.top.some((row) => row.name.includes("<")), false);
  });

  test("a blank name becomes Anonymous rather than an empty row", async () => {
    await finish("tech-and-the-web", "b1", "   ", { right: 1 });
    const response = await fetch(`${BASE}/board?pack=tech-and-the-web&player=b1`);
    const body = await response.json();
    assert.equal(body.you.name, "Anonymous");
  });

  test("every pack comes back in one request", async () => {
    const response = await fetch(
      `${BASE}/boards?packs=mixed-bag,film-and-tv,never-played&player=player-a`
    );
    const { boards } = await response.json();

    assert.equal(boards["mixed-bag"].leader.score, PERFECT);
    assert.equal(boards["mixed-bag"].yourScore, PERFECT);
    assert.equal(boards["film-and-tv"].yourScore, null);
    // A pack nobody has played still gets an entry, so the list has no holes in it.
    assert.deepEqual(boards["never-played"], { players: 0, leader: null, yourScore: null });
  });

  test("asking for no boards is refused rather than answered emptily", async () => {
    const response = await fetch(`${BASE}/boards?packs=`);
    assert.equal(response.status, 400);
  });

  test("the board is readable from the page, wherever it is served from", async () => {
    const response = await fetch(`${BASE}/board?pack=mixed-bag`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
