-- Storage for the daily rounds.
--
-- One row per player per round, in `sessions`. That is the whole scoring model:
-- your first go at a day is the one that counts, whether you played it alone at
-- your desk or live with the room, and both land on the same table.
--
-- `game` holds the one live game there can be at a time. It exists only to say
-- which round the room is playing and when their shared five minutes ends.
--
-- No accounts and no email addresses. A player is a random id their browser made
-- up, plus whatever name they typed.

CREATE TABLE IF NOT EXISTS sessions (
  round       TEXT    NOT NULL,   -- the round's id, which is its date
  player      TEXT    NOT NULL,   -- a random id the browser keeps; not a login
  name        TEXT    NOT NULL,
  mode        TEXT    NOT NULL,   -- 'solo' or 'live'
  started_at  INTEGER,            -- null while a live player waits for the host
  ends_at     INTEGER,            -- null likewise; fixed the moment it starts
  found       INTEGER NOT NULL DEFAULT 0,
  clues       INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,

  -- First attempt only, enforced here rather than in application code. A second
  -- go at a day whose answers you have already seen cannot overwrite the first.
  PRIMARY KEY (round, player)
);

-- Drawing one day's table is the only read this does in anger. Ties go to
-- whoever got there first.
CREATE INDEX IF NOT EXISTS sessions_board ON sessions (round, score DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS game (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  round      TEXT    NOT NULL,
  opened_at  INTEGER NOT NULL,
  started_at INTEGER,
  ends_at    INTEGER
);

-- Counts of requests per player per hour, kept coarse so it cannot be used to
-- follow anyone around: a bucket lives an hour and is then swept.
CREATE TABLE IF NOT EXISTS rate (
  bucket     TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
