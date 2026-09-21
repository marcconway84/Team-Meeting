// End-to-end tests against a real worker with a real database.
//
// The unit tests cover the arithmetic; these cover the things only a running
// service can tell you - that the host owns the clock, that everyone gets the same
// five minutes, that a game ends whether or not anybody is asking, and that the
// board is the server's arithmetic rather than whatever a browser posted.
//
//     npm run test:service

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;
const HOST_KEY = "a-host-key-for-testing";

let worker = null;

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch { /* not up yet */ }
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

async function get(path) {
  const response = await fetch(BASE + path);
  return { status: response.status, body: await response.json() };
}

const openGame = () => post("/host/open", { key: HOST_KEY, round: "sept-28" });
const startGame = () => post("/host/start", { key: HOST_KEY });
const join = (player, name) => post("/join", { player, name });
const report = (player, found, clues = []) => post("/progress", { player, found, clues });

describe("the live game", { concurrency: false }, () => {
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
      ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1",
       "--var", `HOST_KEY:${HOST_KEY}`],
      { cwd: ROOT, stdio: "ignore", env: { ...process.env, CI: "1" } }
    );
    if (!(await waitForHealth())) {
      worker.kill("SIGTERM");
      worker = null;
      throw new Error("wrangler dev did not come up - is it installed?");
    }
  });

  after(() => { if (worker) worker.kill("SIGTERM"); });

  test("a fresh service is a lobby, not an error", async () => {
    const { status, body } = await get("/game");
    assert.equal(status, 200);
    assert.equal(body.phase, "lobby");
    assert.equal(body.endsAt, null);
    assert.ok(Number.isInteger(body.now), "every reply carries the server's own clock");
  });

  test("players gather in the lobby before anything starts", async () => {
    await openGame();
    await join("p1", "Ada");
    const { body } = await join("p2", "Ben");
    assert.equal(body.phase, "lobby");
    assert.equal(body.players, 2);
  });

  test("nobody can score before the host starts it", async () => {
    const { status, body } = await report("p1", 3);
    assert.equal(status, 400);
    assert.match(body.error, /not started/);
  });

  test("only the host can start it", async () => {
    const wrong = await post("/host/start", { key: "not-the-key" });
    assert.equal(wrong.status, 403);
    assert.equal((await get("/game")).body.phase, "lobby", "and it really did not start");
  });

  test("starting it gives everyone the same end time", async () => {
    const started = await startGame();
    assert.equal(started.body.phase, "running");

    const ada = await get("/game?player=p1");
    const ben = await get("/game?player=p2");
    assert.equal(ada.body.endsAt, started.body.endsAt);
    assert.equal(ben.body.endsAt, started.body.endsAt);
    assert.equal(ada.body.seconds, 300, "five minutes");
    // The end is a fixed instant, so a slow client does not get a longer game.
    assert.ok(started.body.endsAt - started.body.now > 290_000);
  });

  test("pressing start twice does not hand out a second five minutes", async () => {
    const first = (await get("/game")).body.endsAt;
    const again = await startGame();
    assert.equal(again.body.endsAt, first);
  });

  test("a correct answer comes back with where you now stand", async () => {
    const { body } = await report("p1", 4);
    assert.equal(body.you.score, 400);
    assert.equal(body.you.rank, 1);
    assert.equal(body.players, 2);
  });

  test("the score on the board is the server's arithmetic, not the browser's", async () => {
    // Posting a made-up total must change nothing: the worker recalculates from
    // what was found and what was bought.
    const { body } = await post("/progress", {
      player: "p2", found: 6, clues: ["where", "hint"], score: 9_999_999, total: 9_999_999,
    });
    assert.equal(body.you.score, 600 - 20 - 45);
  });

  test("overtaking someone changes both their positions", async () => {
    assert.equal((await report("p1", 4)).body.you.rank, 2, "Ben is ahead on 535");
    const ada = await report("p1", 9);
    assert.equal(ada.body.you.score, 900);
    assert.equal(ada.body.you.rank, 1);
    assert.equal((await report("p2", 6, ["where", "hint"])).body.you.rank, 2);
  });

  test("an impossible score is refused rather than ranked", async () => {
    const tooMany = await report("p1", 20);
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /20 found out of a round of 19/);

    const invented = await post("/progress", { player: "p1", found: 2, clues: ["freebie"] });
    assert.equal(invented.status, 400);
  });

  test("somebody who never joined cannot post a score", async () => {
    const { status, body } = await report("gatecrasher", 19);
    assert.equal(status, 400);
    assert.match(body.error, /not in this game/);
  });

  test("a name cannot smuggle markup onto the board", async () => {
    await join("p3", "<script>alert(1)</script>Cal");
    const { body } = await get("/board");
    assert.equal(body.top.some((row) => row.name.includes("<")), false);
  });

  test("a blank name becomes Anonymous rather than an empty row", async () => {
    await join("p4", "   ");
    const { body } = await get("/board");
    assert.ok(body.top.some((row) => row.name === "Anonymous"));
  });

  test("the board is ordered best first and counts everyone in the room", async () => {
    const { body } = await get("/board");
    const scores = body.top.map((row) => row.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(body.top[0].name, "Ada");
    assert.equal(body.players, 4);
  });

  test("the game ends on its own, and then it is over for everybody", async () => {
    // Wind the clock back rather than waiting five minutes: the phase is worked
    // out from the stored end time, so a game in the past is simply over.
    const setup = spawn(
      `${ROOT}node_modules/.bin/wrangler`,
      ["d1", "execute", "quickfire-scores", "--local",
       "--command", `UPDATE game SET ends_at = ${Date.now() - 1000} WHERE id = 1`],
      { cwd: ROOT, stdio: "ignore" }
    );
    await new Promise((resolve) => setup.on("exit", resolve));

    const { body } = await get("/game?player=p1");
    assert.equal(body.phase, "over");
    assert.ok(Array.isArray(body.board), "and the final table comes with it");
    assert.equal(body.board[0].name, "Ada");
  });

  test("a score posted after the whistle does not change the table", async () => {
    const before = (await get("/board")).body.top.find((row) => row.name === "Ada").score;
    const late = await report("p1", 19);
    assert.equal(late.status, 200, "it is answered, not rejected - you just gain nothing");
    const after = (await get("/board")).body.top.find((row) => row.name === "Ada").score;
    assert.equal(after, before);
  });

  test("nobody can join a game that has finished", async () => {
    const { status, body } = await join("latecomer", "Late");
    assert.equal(status, 400);
    assert.match(body.error, /finished/);
  });

  test("a new game empties the room and stops the clock", async () => {
    const { body } = await openGame();
    assert.equal(body.phase, "lobby");
    assert.equal(body.players, 0);
    assert.equal(body.endsAt, null);
  });

  test("the board is readable from the page, wherever it is served from", async () => {
    const response = await fetch(`${BASE}/board`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
});
