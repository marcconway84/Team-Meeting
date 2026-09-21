// Scoring, kept apart from request handling so it can be tested on its own.
//
// The worker never believes the total the browser sends; it recalculates the round
// from what the round consisted of. A leaderboard that takes a number on trust is a
// leaderboard of whoever last opened the console.
//
// The constants come from rules.generated.json, copied there from data/rules.json by
// scripts/generate_worker_rules.py, so the price the player was charged on screen and
// the price the board charges cannot part company.

import RULES from "./rules.generated.json" with { type: "json" };

export { RULES };

export class BadRound extends Error {}

/** How many items this round has, or null if the worker has never heard of it. */
export function roundSize(id) {
  const size = RULES.rounds[String(id || "")];
  return Number.isInteger(size) ? size : null;
}

/** The points a set of bought clues costs. An unknown key is refused, not ignored. */
export function cluePenalty(clues) {
  let total = 0;
  for (const key of clues) {
    const cost = RULES.picture.clueCosts[key];
    if (cost === undefined) throw new BadRound(`unknown clue: ${key}`);
    total += cost;
  }
  return total;
}

/**
 * Score one finished round, refusing anything that could not have been played.
 *
 * The refusals are the point. Twenty found out of nineteen, or a clue the game does
 * not sell, did not come from someone playing the game.
 *
 * Note what is deliberately NOT policed: how long it took. The round is self-paced,
 * so the elapsed time is only ever used to separate two people on the same score,
 * and a browser could under-report it. Checking it against the age of the token
 * catches someone claiming MORE time than they had; nothing here can catch someone
 * claiming less. That is an acceptable hole for a tie-break, and not one for the
 * score itself, which is recalculated here from scratch.
 */
export function scoreRound(round) {
  const items = roundSize(round.round);
  if (items === null) throw new BadRound(`unknown round: ${round.round}`);

  const found = asInteger(round.found, "found");
  const seconds = asInteger(round.seconds, "seconds");
  const clues = Array.isArray(round.clues) ? round.clues : [];

  if (found < 0 || found > items) {
    throw new BadRound(`${found} found out of a round of ${items}`);
  }
  if (seconds < 0) throw new BadRound("a round cannot have taken negative time");
  // Seven kinds of clue, and the letter clue can be bought once per hidden letter.
  // Forty a piece is far past anything a real round reaches.
  if (clues.length > items * 40) {
    throw new BadRound("more clues bought than the round has to sell");
  }
  if (round.items !== undefined && asInteger(round.items, "items") !== items) {
    throw new BadRound("that round does not have that many items");
  }

  // Both bonuses want a clean sheet. A revealed answer is never counted found, so
  // this is also what stops "reveal the lot" buying the finisher bonus.
  const perfect = found === items;
  const base = found * RULES.picture.pointsPerItem;
  const spent = cluePenalty(clues);
  const finisher = perfect ? RULES.picture.finisherBonus : 0;
  const cleanSweep = perfect && clues.length === 0 ? RULES.picture.cleanSweepBonus : 0;
  const total = Math.max(0, base - spent + finisher + cleanSweep);

  return { found, items, base, spent, finisher, cleanSweep, total };
}

function asInteger(value, field) {
  if (!Number.isInteger(value)) throw new BadRound(`${field} must be a whole number`);
  return value;
}
