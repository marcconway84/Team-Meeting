// Scoring, and the refusals that make the board worth reading.
// No network, no Cloudflare - these run anywhere.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BadScore, RULES, cluePenalty, roundSize, scoreFrom } from "../src/scoring.js";

const ROUND = "2026-09-28";
const SIZE = roundSize(ROUND);

function round(overrides = {}) {
  return { round: ROUND, found: SIZE, clues: [], ...overrides };
}

test("the round came across from data/rounds", () => {
  // Checked against the round file rather than a number typed in here. The
  // literal was 20, and when two items were cut from the round this test was
  // the thing that had to be remembered - which is the wrong way round. The
  // round is the source of truth; this asserts the server agrees with it.
  const source = JSON.parse(readFileSync(
    new URL(`../../data/rounds/${ROUND}.json`, import.meta.url), "utf8"));
  assert.equal(SIZE, source.items.length);
  assert.ok(SIZE > 0, "the round has items");
  assert.equal(roundSize("no-such-round"), null);
});

test("a clean sweep collects everything there is", () => {
  const result = scoreFrom(round());
  assert.equal(result.base, SIZE * 100);
  assert.equal(result.finisher, RULES.picture.finisherBonus);
  assert.equal(result.cleanSweep, RULES.picture.cleanSweepBonus);
  assert.equal(result.total, SIZE * 100 + 400 + 400);
});

test("the clock is not part of the score", () => {
  // Everyone plays the same five minutes, so there is nothing to earn by being
  // quick beyond getting more of them - and the scorer is not even told the time.
  const result = scoreFrom(round());
  assert.equal("seconds" in result, false);
});

test("clues are taken off, and cost the clean sweep as well as their price", () => {
  const helped = scoreFrom(round({ clues: ["category"] }));
  assert.equal(helped.spent, 10);
  assert.equal(helped.cleanSweep, 0, "one clue is still a clue");
  assert.equal(helped.finisher, RULES.picture.finisherBonus, "but the finisher survives it");
  assert.equal(helped.total, SIZE * 100 - 10 + 400);
});

test("the letter clue can be bought over and over and charges every time", () => {
  const clues = ["letter", "letter", "letter", "letter"];
  assert.equal(cluePenalty(clues), 4 * RULES.picture.clueCosts.letter);
  assert.equal(scoreFrom(round({ clues })).spent, 60);
});

test("one short and both bonuses are gone", () => {
  const result = scoreFrom(round({ found: SIZE - 1 }));
  assert.equal(result.base, (SIZE - 1) * 100);
  assert.deepEqual([result.finisher, result.cleanSweep], [0, 0],
    "the bonuses want a clean sheet, which is what makes reveal safe to give away free");
  assert.equal(result.total, (SIZE - 1) * 100);
});

test("revealing everything earns nothing at all", () => {
  // The exploit this rules out: reveal the lot and collect the finisher bonus
  // for a round you did not play. A revealed item is never counted found, so
  // `found` is zero and so is the lot.
  const reveals = Array.from({ length: SIZE }, () => "reveal");
  assert.equal(cluePenalty(reveals), 0, "reveal is free");
  assert.equal(scoreFrom(round({ found: 0, clues: reveals })).total, 0);
});

test("a score that could not have been played is refused", () => {
  assert.throws(() => scoreFrom(round({ found: SIZE + 1 })), BadScore, "more found than exist");
  assert.throws(() => scoreFrom(round({ found: -1 })), BadScore, "a negative tally");
  assert.throws(() => scoreFrom(round({ round: "invented" })), BadScore, "a round nobody has");
  assert.throws(() => scoreFrom(round({ found: 1.5 })), BadScore, "a fractional tally");
  assert.throws(() => cluePenalty(["nonsense"]), BadScore, "a clue nobody sells");
});

test("an invented clue is refused rather than priced at nothing", () => {
  assert.throws(() => cluePenalty(["freebie"]), BadScore);
  assert.throws(() => scoreFrom(round({ clues: ["category", "freebie"] })), BadScore);
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
