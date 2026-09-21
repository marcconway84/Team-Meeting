// Scoring, and the refusals that make the board worth reading.
// No network, no Cloudflare - these run anywhere.

import assert from "node:assert/strict";
import test from "node:test";

import { BadRound, RULES, cluePenalty, roundSize, scoreRound } from "../src/scoring.js";

const ROUND = "sept-28";
const SIZE = roundSize(ROUND);

function round(overrides = {}) {
  return { round: ROUND, found: SIZE, seconds: 600, clues: [], ...overrides };
}

test("the round came across from data/rounds", () => {
  assert.equal(SIZE, 19);
  assert.equal(roundSize("no-such-round"), null);
});

test("a clean sweep collects everything there is", () => {
  const result = scoreRound(round());
  assert.equal(result.base, 1900);
  assert.equal(result.finisher, RULES.picture.finisherBonus);
  assert.equal(result.cleanSweep, RULES.picture.cleanSweepBonus);
  assert.equal(result.total, 1900 + 400 + 400);
});

test("taking longer earns nothing and costs nothing", () => {
  // The round is self-paced. Time is a tie-break on the board, never a score.
  const quick = scoreRound(round({ seconds: 60 }));
  const slow = scoreRound(round({ seconds: 6000 }));
  assert.equal(quick.total, slow.total);
});

test("clues are taken off, and cost the clean sweep as well as their price", () => {
  const helped = scoreRound(round({ clues: ["category"] }));
  assert.equal(helped.spent, 10);
  assert.equal(helped.cleanSweep, 0, "one clue is still a clue");
  assert.equal(helped.finisher, RULES.picture.finisherBonus, "but the finisher survives it");
  assert.equal(helped.total, 1900 - 10 + 400);
});

test("the letter clue can be bought over and over and charges every time", () => {
  const clues = ["letter", "letter", "letter", "letter"];
  assert.equal(cluePenalty(clues), 4 * RULES.picture.clueCosts.letter);
  assert.equal(scoreRound(round({ clues })).spent, 60);
});

test("one short and both bonuses are gone", () => {
  const result = scoreRound(round({ found: SIZE - 1 }));
  assert.equal(result.base, 1800);
  assert.deepEqual([result.finisher, result.cleanSweep], [0, 0],
    "the bonuses want a clean sheet, which is what makes reveal safe to give away free");
  assert.equal(result.total, 1800);
});

test("revealing everything earns nothing at all", () => {
  // The exploit this rules out: reveal all nineteen and collect the finisher bonus
  // for a round you did not play. A revealed item is never counted found, so
  // `found` is zero and so is the lot.
  const reveals = Array.from({ length: SIZE }, () => "reveal");
  assert.equal(cluePenalty(reveals), 0, "reveal is free");
  assert.equal(scoreRound(round({ found: 0, clues: reveals })).total, 0);
});

test("a score that could not have been played is refused", () => {
  assert.throws(() => scoreRound(round({ found: SIZE + 1 })), BadRound, "more found than exist");
  assert.throws(() => scoreRound(round({ found: -1 })), BadRound, "a negative tally");
  assert.throws(() => scoreRound(round({ seconds: -5 })), BadRound, "a negative clock");
  assert.throws(() => scoreRound(round({ round: "invented" })), BadRound, "a round nobody has");
  assert.throws(() => scoreRound(round({ found: 1.5 })), BadRound, "a fractional tally");
  assert.throws(() => scoreRound(round({ items: 3 })), BadRound, "a round resized in flight");
});

test("an invented clue is refused rather than priced at nothing", () => {
  assert.throws(() => cluePenalty(["freebie"]), BadRound);
  assert.throws(() => scoreRound(round({ clues: ["category", "freebie"] })), BadRound);
});

test("the price list is the one the browser was shown", () => {
  // data/rules.json is the original; this file is generated from it. If the two ever
  // part company the player is charged one price and ranked on another.
  assert.equal(RULES.picture.clueCosts.reveal, 0);
  assert.equal(RULES.picture.pointsPerItem, 100);
  for (const [key, cost] of Object.entries(RULES.picture.clueCosts)) {
    assert.ok(Number.isInteger(cost) && cost >= 0, `${key} is priced oddly: ${cost}`);
    assert.ok(cost < RULES.picture.pointsPerItem, `${key} costs more than an item is worth`);
  }
});
