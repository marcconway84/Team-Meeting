// Scoring, kept apart from request handling so it can be tested on its own.
//
// The board never shows a total the browser posted. A client says how many it has
// found and which clues it bought; the arithmetic happens here. That is what stops
// two players who played identically appearing on the board with different numbers,
// and it is the only reason a shared table is worth looking at.
//
// The constants come from rules.generated.json, copied there from data/rules.json by
// scripts/generate_worker_rules.py, so the price the player was charged on screen and
// the price the board charges cannot part company.

import RULES from "./rules.generated.json" with { type: "json" };

export { RULES };

export class BadScore extends Error {}

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
    if (cost === undefined) throw new BadScore(`unknown clue: ${key}`);
    total += cost;
  }
  return total;
}

/**
 * Score one player's progress, refusing anything that could not have happened.
 *
 * Called on every correct answer rather than once at the end, because the board is
 * live - so it has to be cheap, and it has to refuse nonsense every single time
 * rather than trusting a running total it handed out earlier.
 */
export function scoreFrom(progress) {
  const items = roundSize(progress.round);
  if (items === null) throw new BadScore(`unknown round: ${progress.round}`);

  const found = progress.found;
  if (!Number.isInteger(found)) throw new BadScore("found must be a whole number");
  if (found < 0 || found > items) {
    throw new BadScore(`${found} found out of a round of ${items}`);
  }

  const clues = Array.isArray(progress.clues) ? progress.clues : [];
  if (clues.length > items * 40) throw new BadScore("more clues than the round has to sell");

  // Both bonuses want a clean sheet. A revealed answer is never counted found, so
  // this is also what stops "reveal the lot" buying the finisher bonus.
  const perfect = found === items;
  const base = found * RULES.picture.pointsPerItem;
  const spent = cluePenalty(clues);
  const finisher = perfect ? RULES.picture.finisherBonus : 0;
  const cleanSweep = perfect && clues.length === 0 ? RULES.picture.cleanSweepBonus : 0;
  const total = Math.max(0, base - spent + finisher + cleanSweep);

  return { found, items, base, spent, finisher, cleanSweep, total, clueCount: clues.length };
}
