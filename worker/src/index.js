// The leaderboard: a small HTTP service in front of one SQLite table.
//
// Four routes:
//
//   POST /round/start   a round is beginning - hand back a signed token
//   POST /round/finish  a round has ended - recalculate it, store it, return the board
//   GET  /board         the top ten for one pack, and where this player came
//   GET  /boards        the leader and your own score for every pack at once
//
// The rule the game is built around - a pack counts on your first attempt only - is
// a primary key on (pack, player), so it holds even if something above it is wrong.
//
// Nothing here trusts the number the browser reports. Every score is recalculated
// from what the round consisted of, which is the only reason a public board is worth
// reading.

import { BadRound, RULES, packSize, scoreRound } from "./scoring.js";
import { BadToken, issue, open } from "./session.js";

const BOARD_SIZE = 10;
const MAX_NAME = 24;
const ROUNDS_PER_HOUR = 120;
const TOKEN_SWEEP_MS = 3 * 60 * 60 * 1000;
const MAX_BOARDS = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/round/start" && request.method === "POST") {
        return cors(await startRound(request, env));
      }
      if (url.pathname === "/round/finish" && request.method === "POST") {
        return cors(await finishRound(request, env));
      }
      if (url.pathname === "/board" && request.method === "GET") {
        return cors(await board(url, env));
      }
      if (url.pathname === "/boards" && request.method === "GET") {
        return cors(await boards(url, env));
      }
      if (url.pathname === "/health") return cors(json({ ok: true }));
      return cors(json({ error: "no such route" }, 404));
    } catch (err) {
      if (err instanceof BadRound || err instanceof BadToken) {
        return cors(json({ error: err.message }, 400));
      }
      console.error(err);
      return cors(json({ error: "something went wrong" }, 500));
    }
  },
};

async function startRound(request, env) {
  const body = await readJson(request);
  const pack = requireText(body.pack, "pack", 64);
  if (packSize(pack) === null) throw new BadRound(`unknown pack: ${pack}`);

  if (!(await underRateLimit(request, env))) {
    return json({ error: "too many rounds from here in the last hour" }, 429);
  }
  return json({ token: await issue(env.SCORE_SECRET, { pack }) });
}

async function finishRound(request, env) {
  const body = await readJson(request);
  const claims = await open(env.SCORE_SECRET, body.token);
  const player = requireText(body.player, "player", 64);
  const name = tidyName(body.name);

  // The clock the player reports has to square with how long they actually held the
  // token. Without this a ten minute round could be started and finished in the same
  // second with the full clock still showing, which is where the time bonus lives.
  const held = Math.round(claims.age / 1000);
  const claimedSpend = RULES.secondsOnTheClock - toInt(body.secondsLeft);
  if (claimedSpend > held + 5) {
    throw new BadRound("the round ended sooner than it could have been played");
  }

  const result = scoreRound({
    pack: claims.pack,
    right: toInt(body.right),
    questions: body.questions === undefined ? undefined : toInt(body.questions),
    secondsLeft: toInt(body.secondsLeft),
    clues: body.clues,
  });

  // One token, one score. Replaying a good round under new player ids would
  // otherwise fill the board from a single genuine game.
  const fresh = await env.DB.prepare(
    "INSERT OR IGNORE INTO spent_tokens (nonce, created_at) VALUES (?, ?)"
  )
    .bind(claims.nonce, Date.now())
    .run();
  if (!fresh.meta.changes) throw new BadToken("this round has already been submitted");

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO scores
       (pack, player, name, score, right_answers, questions, clues, seconds_left, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      claims.pack,
      player,
      name,
      result.total,
      result.right,
      result.questions,
      Array.isArray(body.clues) ? body.clues.length : 0,
      toInt(body.secondsLeft),
      Date.now()
    )
    .run();

  await sweep(env);

  const standings = await standingsFor(env, claims.pack, player);
  return json({
    ...standings,
    score: result.total,
    breakdown: result,
    // Says plainly why a second run at the same pack did not move the board, rather
    // than looking like the submission failed.
    counted: Boolean(inserted.meta.changes),
    reason: inserted.meta.changes ? null : "only your first attempt at a pack counts",
  });
}

async function board(url, env) {
  const pack = requireText(url.searchParams.get("pack"), "pack", 64);
  const player = url.searchParams.get("player") || null;
  return json(await standingsFor(env, pack, player));
}

/**
 * Every pack in one request, for the pack list on the front page.
 *
 * One request rather than one per pack: a page that fires a request per card is a
 * page that feels broken on a phone. Only the leader and the asking player's own
 * score come back, which is all the list shows - the full board is a round away.
 */
async function boards(url, env) {
  const wanted = (url.searchParams.get("packs") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!wanted.length) throw new BadRound("packs is required");
  if (wanted.length > MAX_BOARDS) throw new BadRound(`at most ${MAX_BOARDS} boards at a time`);
  const player = url.searchParams.get("player") || null;

  const placeholders = wanted.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT pack, name, score FROM scores WHERE pack IN (${placeholders})
       ORDER BY pack, score DESC, created_at ASC`
  )
    .bind(...wanted)
    .all();

  const counts = new Map();
  const leaders = new Map();
  for (const row of rows.results || []) {
    counts.set(row.pack, (counts.get(row.pack) || 0) + 1);
    if (!leaders.has(row.pack)) leaders.set(row.pack, { name: row.name, score: row.score });
  }

  const mine = new Map();
  if (player) {
    const own = await env.DB.prepare(
      `SELECT pack, score FROM scores WHERE player = ? AND pack IN (${placeholders})`
    )
      .bind(player, ...wanted)
      .all();
    for (const row of own.results || []) mine.set(row.pack, row.score);
  }

  const out = {};
  for (const pack of wanted) {
    out[pack] = {
      players: counts.get(pack) || 0,
      leader: leaders.get(pack) || null,
      yourScore: mine.has(pack) ? mine.get(pack) : null,
    };
  }
  return json({ boards: out });
}

async function standingsFor(env, pack, player) {
  const top = await env.DB.prepare(
    `SELECT name, score, right_answers AS correct, questions
       FROM scores WHERE pack = ?
       ORDER BY score DESC, created_at ASC LIMIT ?`
  )
    .bind(pack, BOARD_SIZE)
    .all();

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE pack = ?")
    .bind(pack)
    .first();

  let you = null;
  if (player) {
    const own = await env.DB.prepare(
      "SELECT name, score, right_answers AS correct FROM scores WHERE pack = ? AND player = ?"
    )
      .bind(pack, player)
      .first();
    if (own) {
      // Rank by how many beat you, so equal scores share a place rather than being
      // ordered by who happened to submit first.
      const ahead = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM scores WHERE pack = ? AND score > ?"
      )
        .bind(pack, own.score)
        .first();
      you = { ...own, rank: ahead.n + 1 };
    }
  }

  return { pack, players: total.n, top: top.results || [], you };
}

async function underRateLimit(request, env) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const hour = Math.floor(Date.now() / 3_600_000);
  const bucket = await hash(`${address}:${hour}`);
  await env.DB.prepare(
    `INSERT INTO rate (bucket, hits, created_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1`
  )
    .bind(bucket, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT hits FROM rate WHERE bucket = ?").bind(bucket).first();
  return row.hits <= ROUNDS_PER_HOUR;
}

/** Drop spent tokens and rate buckets once they can no longer matter. */
async function sweep(env) {
  const cutoff = Date.now() - TOKEN_SWEEP_MS;
  await env.DB.prepare("DELETE FROM spent_tokens WHERE created_at < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM rate WHERE created_at < ?").bind(cutoff).run();
}

async function hash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRound("expected a JSON body");
  }
}

function requireText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new BadRound(`${field} is required`);
  if (value.length > max) throw new BadRound(`${field} is too long`);
  return value.trim();
}

function toInt(value) {
  if (!Number.isInteger(value)) throw new BadRound("expected whole numbers for the round");
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
  // The game is served from GitHub Pages and can be opened from anywhere, so the
  // board is readable by any origin. There is nothing private behind it.
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, headers });
}
