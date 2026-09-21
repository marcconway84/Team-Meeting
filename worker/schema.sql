-- The live game's storage.
--
-- One game at a time, and one row per player in it. That is the whole model: the
-- host opens a game, everybody joins it, the host starts it, and five minutes
-- later it is over for all of them at once.
--
-- No accounts and no email addresses. A player is a random id their browser made
-- up, plus whatever name they typed.

-- Exactly one row, ever. The CHECK is what makes that true rather than hoped for.
CREATE TABLE IF NOT EXISTS game (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  round      TEXT    NOT NULL,
  opened_at  INTEGER NOT NULL,   -- unix ms
  started_at INTEGER,            -- null until the host presses start
  ends_at    INTEGER             -- started_at + the round length, fixed at start
);

CREATE TABLE IF NOT EXISTS players (
  player      TEXT PRIMARY KEY,  -- a random id the browser keeps; not a login
  name        TEXT NOT NULL,
  found       INTEGER NOT NULL DEFAULT 0,
  clues       INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  joined_at   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Drawing the board is the only read this table does in anger. Ties go to whoever
-- got there first, which is the fairest thing available when everybody is playing
-- the same five minutes.
CREATE INDEX IF NOT EXISTS players_board ON players (score DESC, updated_at ASC);

-- Counts of requests per address per hour, kept coarse so it cannot be used to
-- follow anyone around: an address appears here for an hour and is then swept.
CREATE TABLE IF NOT EXISTS rate (
  bucket     TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
