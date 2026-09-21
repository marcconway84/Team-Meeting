// The live game: one HTTP service in front of two small tables.
//
// The thing it exists to own is the clock. Everyone plays the same five minutes,
// so the start and the end are decided here and handed out - a client never
// decides for itself when time is up, and never trusts its own wall clock, which
// on a room full of laptops is wrong by a surprising amount.
//
//   GET  /game         where are we: waiting, playing (with the end time), or over
//   POST /join         put a name in the room
//   POST /progress     I have found another one - where does that put me
//   GET  /board        the final table
//   POST /host/open    start a fresh game, everybody out (host only)
//   POST /host/start   go (host only)
//
// Every reply carries `now`, the server's own clock, so a client can work out how
// far its own is out and count down against ours instead of its own.

import { BadScore, RULES, scoreFrom } from "./scoring.js";

const MAX_NAME = 24;
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
      if (url.pathname === "/join" && request.method === "POST") {
        return cors(await join(request, env));
      }
      if (url.pathname === "/progress" && request.method === "POST") {
        return cors(await progress(request, env));
      }
      if (url.pathname === "/board" && request.method === "GET") {
        return cors(json({ ...(await board(env)), now: Date.now() }));
      }
      if (url.pathname === "/host/open" && request.method === "POST") {
        return cors(await hostOpen(request, env));
      }
      if (url.pathname === "/host/start" && request.method === "POST") {
        return cors(await hostStart(request, env));
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
  if (row) return row;
  // A service that has never been opened still has to answer sensibly, so the
  // first caller creates the lobby rather than getting an error.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO game (id, round, opened_at) VALUES (1, ?, ?)"
  )
    .bind("sept-28", Date.now())
    .run();
  return env.DB.prepare("SELECT * FROM game WHERE id = 1").first();
}

/**
 * Which of the three states we are in.
 *
 * Worked out from the stored end time rather than stored as a word, so a game
 * ends on time whether or not anybody happens to be asking.
 */
function phaseOf(game, now) {
  if (!game.started_at) return "lobby";
  return now < game.ends_at ? "running" : "over";
}

async function describe(env, game, player) {
  const now = Date.now();
  const phase = phaseOf(game, now);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first();

  const out = {
    phase,
    now,
    round: game.round,
    players: count.n,
    startsAt: game.started_at || null,
    endsAt: game.ends_at || null,
    seconds: RULES.live.seconds,
  };
  if (phase === "over") out.board = (await board(env)).top;
  if (player) {
    const you = await standing(env, player);
    if (you) out.you = you;
  }
  return out;
}

async function gameState(url, env) {
  await rateLimit(url, env);
  const game = await currentGame(env);
  return json(await describe(env, game, url.searchParams.get("player")));
}

async function join(request, env) {
  const body = await readJson(request);
  const player = requireText(body.player, "player", 64);
  const name = tidyName(body.name);
  const game = await currentGame(env);
  const now = Date.now();

  // Joining once the clock has stopped would add a name to a finished table.
  if (phaseOf(game, now) === "over") {
    throw new BadRequest("that game has finished");
  }

  await env.DB.prepare(
    `INSERT INTO players (player, name, joined_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(player) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`
  )
    .bind(player, name, now, now)
    .run();

  return json(await describe(env, game, player));
}

/**
 * A player has found another one.
 *
 * The client says how many it has found and which clues it bought; the score is
 * worked out here from those, so the number on the board is always this service's
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
  const phase = phaseOf(game, now);

  if (phase === "lobby") throw new BadRequest("the game has not started");

  const known = await env.DB.prepare("SELECT player FROM players WHERE player = ?")
    .bind(player)
    .first();
  if (!known) throw new BadRequest("you are not in this game");

  const result = scoreFrom({
    round: game.round,
    found: toInt(body.found),
    clues: body.clues,
  });

  // Once time is up the table is closed. A late arrival is scored as whatever it
  // had when the whistle went, not as whatever it kept typing afterwards.
  if (phase === "running") {
    await env.DB.prepare(
      `UPDATE players SET found = ?, clues = ?, score = ?, updated_at = ?
       WHERE player = ? AND found <= ?`
    )
      .bind(result.found, result.clueCount, result.total, now, player, result.found)
      .run();
  }

  const you = await standing(env, player);
  return json({
    phase,
    now,
    endsAt: game.ends_at,
    you,
    players: (await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first()).n,
    leader: (await board(env)).top[0] || null,
  });
}

/** Where one player stands: their score, and how many are ahead of them. */
async function standing(env, player) {
  const own = await env.DB.prepare(
    "SELECT name, score, found, clues FROM players WHERE player = ?"
  )
    .bind(player)
    .first();
  if (!own) return null;
  // Rank by how many beat you, so equal scores share a place rather than being
  // ordered by who happened to submit first.
  const ahead = await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE score > ?")
    .bind(own.score)
    .first();
  return { ...own, rank: ahead.n + 1 };
}

async function board(env) {
  const top = await env.DB.prepare(
    `SELECT name, score, found, clues FROM players
     ORDER BY score DESC, updated_at ASC LIMIT ?`
  )
    .bind(RULES.live.boardSize)
    .all();
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first();
  return { top: top.results || [], players: count.n };
}

/* ------------------------------------------------------------------- the host -- */

function checkHost(body, env) {
  const key = String(body.key || "");
  const expected = String(env.HOST_KEY || "");
  if (!expected) throw new BadRequest("no host key is configured on the server", 500);
  if (key.length !== expected.length || !timingSafeEqual(key, expected)) {
    throw new BadRequest("that is not the host key", 403);
  }
}

/** A fresh game: the table is cleared and everybody has to join again. */
async function hostOpen(request, env) {
  const body = await readJson(request);
  checkHost(body, env);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM players").run();
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
  return json(await describe(env, await currentGame(env), null));
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
