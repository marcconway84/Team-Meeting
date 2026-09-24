// The live game: one HTTP service in front of two small tables.
//
// The thing it exists to own is the clock. Everyone plays the same five minutes,
// so the start and the end are decided here and handed out - a client never
// decides for itself when time is up, and never trusts its own wall clock, which
// on a room full of laptops is wrong by a surprising amount.
//
//   GET  /game         where are we: waiting, playing (with the end time), or over
//   POST /solo/start   I am playing today's on my own, starting now
//   POST /join         put a name in the room for the hosted game
//   POST /progress     I have found another one - where does that put me
//   GET  /board        one day's table
//   POST /host/check   is this the host key? (host only, changes nothing)
//   POST /host/open    start a fresh game, everybody out (host only)
//   POST /host/start   go (host only)
//   POST /host/clear   tear up a day's table, or one name on it (host only)
//
// Every reply carries `now`, the server's own clock, so a client can work out how
// far its own is out and count down against ours instead of its own.

import { BadScore, RULES, roundSize, scoreFrom } from "./scoring.js";

const MAX_NAME = 24;

// How long a finished game's results stay up before the room opens itself again.
//
// "Over" used to be permanent: once the clock ran out, /join refused everybody
// and the only way back was a host with the password. That is a room nobody can
// use and nobody present can fix - a bad state for a game whose whole point is
// that somebody presses go in front of a meeting.
//
// Reopening returns the *room* to a lobby. It does not touch a single score:
// the session rows stay exactly where they are, so a day already played is
// still refused a second go, and rejoining keeps the clock and score you had.
const RESULTS_MS = 5 * 60 * 1000;

/** Overridable so the tests do not have to wait five real minutes. */
function resultsMs(env) {
  const override = Number(env.RESULTS_MS);
  return Number.isFinite(override) && override >= 0 ? override : RESULTS_MS;
}
const REQUESTS_PER_HOUR = 4000;
const SWEEP_MS = 6 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/game" && request.method === "GET") {
        return cors(await gameState(url, env));
      }
      if (url.pathname === "/solo/start" && request.method === "POST") {
        return cors(await soloStart(request, env));
      }
      if (url.pathname === "/join" && request.method === "POST") {
        return cors(await join(request, env));
      }
      if (url.pathname === "/progress" && request.method === "POST") {
        return cors(await progress(request, env));
      }
      if (url.pathname === "/board" && request.method === "GET") {
        const round = url.searchParams.get("round") || (await currentGame(env)).round;
        return cors(json({ ...(await board(env, round)), now: Date.now() }));
      }
      if (url.pathname === "/host/check" && request.method === "POST") {
        return cors(await hostCheck(request, env));
      }
      if (url.pathname === "/host/open" && request.method === "POST") {
        return cors(await hostOpen(request, env));
      }
      if (url.pathname === "/host/start" && request.method === "POST") {
        return cors(await hostStart(request, env));
      }
      if (url.pathname === "/host/clear" && request.method === "POST") {
        return cors(await hostClear(request, env));
      }
      if (url.pathname === "/health") return cors(json({ ok: true }));
      return cors(json({ error: "no such route" }, 404));
    } catch (err) {
      if (err instanceof BadRequest) return cors(json({ error: err.message }, err.status));
      // A score that could not have happened is the caller's problem, not ours:
      // it deserves the reason back, not a blank 500.
      if (err instanceof BadScore) return cors(json({ error: err.message }, 400));
      console.error(err);
      return cors(json({ error: "something went wrong" }, 500));
    }
  },
};

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ the game -- */

async function currentGame(env) {
  const row = await env.DB.prepare("SELECT * FROM game WHERE id = 1").first();
  if (row) return reopenIfStale(env, row);
  // A service that has never been opened still has to answer sensibly, so the
  // first caller creates the lobby rather than getting an error.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO game (id, round, opened_at) VALUES (1, ?, ?)"
  )
    .bind(defaultRound(), Date.now())
    .run();
  return env.DB.prepare("SELECT * FROM game WHERE id = 1").first();
}

/**
 * A game whose results have been up long enough goes back to being a lobby.
 *
 * Done here because every route loads the game through currentGame(), so there
 * is no path that can see a stale "over" and act on it.
 */
async function reopenIfStale(env, game) {
  if (!game.started_at || !game.ends_at) return game;
  if (Date.now() < game.ends_at + resultsMs(env)) return game;
  await env.DB.prepare(
    "UPDATE game SET started_at = NULL, ends_at = NULL, opened_at = ? WHERE id = 1"
  )
    .bind(Date.now())
    .run();
  return { ...game, started_at: null, ends_at: null };
}

/** Whichever round the server knows about, latest first. */
function defaultRound() {
  const ids = Object.keys(RULES.rounds).sort();
  return ids[ids.length - 1] || "unknown";
}

/**
 * Which of the three states the hosted game is in.
 *
 * Worked out from the stored end time rather than kept as a word, so a game ends
 * on time whether or not anybody happens to be asking.
 */
function phaseOf(game, now) {
  if (!game.started_at) return "lobby";
  return now < game.ends_at ? "running" : "over";
}

async function describe(env, game, player, round) {
  const now = Date.now();
  const phase = phaseOf(game, now);
  const on = round || game.round;
  const playing = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE round = ?"
  )
    .bind(game.round)
    .first();
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE round = ? AND mode = 'live' AND ends_at IS NULL"
  )
    .bind(game.round)
    .first();

  const out = {
    phase,
    now,
    round: game.round,
    players: playing.n,
    waiting: waiting.n,
    startsAt: game.started_at || null,
    endsAt: game.ends_at || null,
    seconds: RULES.live.seconds,
  };
  if (phase === "over") out.board = (await board(env, game.round)).top;
  if (player) {
    const you = await standing(env, on, player);
    if (you) out.you = you;
  }
  return out;
}

async function gameState(url, env) {
  await rateLimit(url, env);
  const game = await currentGame(env);
  return json(await describe(env, game, url.searchParams.get("player"),
    url.searchParams.get("round")));
}

/**
 * Start a round on your own, now.
 *
 * The end time still comes from here, so a solo five minutes is the same five
 * minutes the room gets and the two belong on one table. A day already played is
 * reported as played rather than handed a second clock - the row is the record,
 * and its primary key is what makes first-attempt-only true rather than hoped for.
 */
async function soloStart(request, env) {
  const body = await readJson(request);
  const player = requireText(body.player, "player", 64);
  const name = tidyName(body.name);
  const round = requireText(body.round, "round", 64);
  if (!roundSize(round)) throw new BadRequest(`unknown round: ${round}`);

  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO sessions
       (round, player, name, mode, started_at, ends_at, updated_at)
     VALUES (?, ?, ?, 'solo', ?, ?, ?)`
  )
    .bind(round, player, name, now, now + RULES.live.seconds * 1000, now)
    .run();

  const own = await env.DB.prepare(
    "SELECT started_at, ends_at FROM sessions WHERE round = ? AND player = ?"
  )
    .bind(round, player)
    .first();

  const game = await currentGame(env);
  return json({
    ...(await describe(env, game, player, round)),
    played: !inserted.meta.changes,
    phase: "running",
    endsAt: own.ends_at,
    startsAt: own.started_at,
    round,
  });
}

async function join(request, env) {
  const body = await readJson(request);
  const player = requireText(body.player, "player", 64);
  const name = tidyName(body.name);
  const game = await currentGame(env);
  const now = Date.now();

  if (phaseOf(game, now) === "over") throw new BadRequest("that game has finished");

  // A live player waits with no clock of their own until the host starts one.
  await env.DB.prepare(
    `INSERT INTO sessions (round, player, name, mode, updated_at) VALUES (?, ?, ?, 'live', ?)
     ON CONFLICT(round, player) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  )
    .bind(game.round, player, name, now)
    .run();

  // Joining after the off should not cost you the minutes already gone.
  if (phaseOf(game, now) === "running") {
    await env.DB.prepare(
      `UPDATE sessions SET started_at = COALESCE(started_at, ?), ends_at = COALESCE(ends_at, ?)
       WHERE round = ? AND player = ?`
    )
      .bind(game.started_at, game.ends_at, game.round, player)
      .run();
  }

  return json(await describe(env, game, player, game.round));
}

/**
 * A player has found another one.
 *
 * The client says how many it has found and which clues it bought; the score is
 * worked out here from those, so the number on the table is always this service's
 * arithmetic and never a total the browser posted.
 *
 * What is taken on trust is the count of answers found. Checking that properly
 * would mean holding the answers here and round-tripping every keystroke, and the
 * answers are readable in the page anyway - this is an ice breaker, and the person
 * who opens the console to win has already lost.
 */
async function progress(request, env) {
  const body = await readJson(request);
  const player = requireText(body.player, "player", 64);
  const game = await currentGame(env);
  const now = Date.now();
  const round = String(body.round || game.round);

  const own = await env.DB.prepare(
    "SELECT started_at, ends_at FROM sessions WHERE round = ? AND player = ?"
  )
    .bind(round, player)
    .first();
  if (!own) throw new BadRequest("you have not started that round");
  if (!own.ends_at) throw new BadRequest("the game has not started");

  const result = scoreFrom({ round, found: toInt(body.found), clues: body.clues });

  // Once the clock has stopped the row is closed. A late arrival is scored as
  // whatever it had when the whistle went, not as whatever it kept typing after.
  if (now < own.ends_at) {
    await env.DB.prepare(
      `UPDATE sessions SET found = ?, clues = ?, score = ?, updated_at = ?
       WHERE round = ? AND player = ? AND found <= ?`
    )
      .bind(result.found, result.clueCount, result.total, now, round, player, result.found)
      .run();
  }

  const table = await board(env, round);
  return json({
    phase: now < own.ends_at ? "running" : "over",
    now,
    round,
    endsAt: own.ends_at,
    you: await standing(env, round, player),
    players: table.players,
    leader: table.top[0] || null,
  });
}

/** Where one player stands on one day: their score, and how many are ahead. */
async function standing(env, round, player) {
  const own = await env.DB.prepare(
    "SELECT name, score, found, clues FROM sessions WHERE round = ? AND player = ?"
  )
    .bind(round, player)
    .first();
  if (!own) return null;
  // Rank by how many beat you, so equal scores share a place rather than being
  // ordered by who happened to submit first.
  const ahead = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE round = ? AND score > ?"
  )
    .bind(round, own.score)
    .first();
  return { ...own, rank: ahead.n + 1 };
}

async function board(env, round) {
  const top = await env.DB.prepare(
    `SELECT name, score, found, clues FROM sessions WHERE round = ?
     ORDER BY score DESC, updated_at ASC LIMIT ?`
  )
    .bind(round, RULES.live.boardSize)
    .all();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE round = ?")
    .bind(round)
    .first();
  return { top: top.results || [], players: count.n, round };
}

/* ------------------------------------------------------------------- the host -- */

function checkHost(body, env) {
  // Trimmed on both sides. A key pasted into the dashboard with a stray newline
  // on the end would otherwise never match, and the refusal would give no hint why.
  const key = String(body.key || "").trim();
  const expected = String(env.HOST_KEY || "").trim();
  if (!expected) throw new BadRequest("no host key is set on the server", 500);
  if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
    throw new BadRequest("that is not the host key", 403);
  }
}

/**
 * Is this the host key?
 *
 * Exists so a host can find out before the meeting rather than in front of it.
 * Every other host route does something - starts the clock, empties the room -
 * so there was no way to ask the question without also answering it.
 */
async function hostCheck(request, env) {
  const body = await readJson(request);
  checkHost(body, env);
  return json({ ok: true, ...(await describe(env, await currentGame(env), null)) });
}

/**
 * A fresh game: the clock is cleared and the lobby emptied.
 *
 * Scores are deliberately left alone. They are the day's table now, not this
 * session's, and a first attempt is a first attempt however the host feels about
 * it. To give people something new to play, open a different round.
 */
async function hostOpen(request, env) {
  const body = await readJson(request);
  checkHost(body, env);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM sessions WHERE mode = 'live' AND score = 0").run();
  await env.DB.prepare(
    `INSERT INTO game (id, round, opened_at, started_at, ends_at) VALUES (1, ?, ?, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET round = excluded.round, opened_at = excluded.opened_at,
       started_at = NULL, ends_at = NULL`
  )
    .bind(String(body.round || "sept-28"), now)
    .run();
  await sweep(env);
  return json(await describe(env, await currentGame(env), null));
}

/** Go. The end time is fixed here and now, and handed to everyone who asks. */
async function hostStart(request, env) {
  const body = await readJson(request);
  checkHost(body, env);
  const game = await currentGame(env);
  const now = Date.now();

  if (game.started_at && phaseOf(game, now) === "running") {
    // Pressing start twice must not hand the room a second five minutes.
    return json(await describe(env, game, null));
  }

  const ends = now + RULES.live.seconds * 1000;
  await env.DB.prepare("UPDATE game SET started_at = ?, ends_at = ? WHERE id = 1")
    .bind(now, ends)
    .run();
  // Everyone already waiting gets that same window. Nobody's clock is their own.
  await env.DB.prepare(
    `UPDATE sessions SET started_at = ?, ends_at = ?, updated_at = ?
     WHERE round = ? AND mode = 'live' AND ends_at IS NULL`
  )
    .bind(now, ends, now, game.round)
    .run();
  return json(await describe(env, await currentGame(env), null));
}

/**
 * Tear up a day's table.
 *
 * One go per person per day is the rule, and the row is what enforces it, so the
 * only honest way to give somebody another go is to take the row away. With a
 * name, that person's row for that day goes and they can play it again; without
 * one, the whole day goes.
 *
 * It is host-only because it is destructive, not because the rule is a security
 * boundary - the player id lives in the browser, so anyone willing to clear their
 * own storage was always going to get a second go. This is the sanctioned way,
 * and the one that does not leave a stranger on the board.
 */
async function hostClear(request, env) {
  const body = await readJson(request);
  checkHost(body, env);
  const round = requireText(body.round, "round", 64);
  const name = String(body.name || "").trim();

  const gone = name
    ? await env.DB.prepare(
        "DELETE FROM sessions WHERE round = ? AND lower(name) = lower(?)"
      )
        .bind(round, name)
        .run()
    : await env.DB.prepare("DELETE FROM sessions WHERE round = ?").bind(round).run();

  return json({
    cleared: gone.meta.changes,
    who: name || null,
    ...(await describe(env, await currentGame(env), null, round)),
    round,
  });
}

/* ----------------------------------------------------------------- plumbing -- */

async function rateLimit(url, env) {
  // Polling is the whole design here, so the ceiling is high; it exists to stop a
  // runaway loop, not to ration honest play.
  const bucket = await hash(`${url.searchParams.get("player") || "anon"}:${Math.floor(Date.now() / 3_600_000)}`);
  await env.DB.prepare(
    `INSERT INTO rate (bucket, hits, created_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1`
  )
    .bind(bucket, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT hits FROM rate WHERE bucket = ?").bind(bucket).first();
  if (row.hits > REQUESTS_PER_HOUR) throw new BadRequest("too many requests", 429);
}

async function sweep(env) {
  await env.DB.prepare("DELETE FROM rate WHERE created_at < ?").bind(Date.now() - SWEEP_MS).run();
}

async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("expected a JSON body");
  }
}

function requireText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${field} is required`);
  if (value.length > max) throw new BadRequest(`${field} is too long`);
  return value.trim();
}

function toInt(value) {
  if (!Number.isInteger(value)) throw new BadRequest("expected whole numbers");
  return value;
}

/** A display name, trimmed and stripped of anything that could break a page. */
function tidyName(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME);
  return cleaned || "Anonymous";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  // Served from GitHub Pages and openable from anywhere. There is nothing private
  // behind it: a leaderboard of first names and a countdown.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
