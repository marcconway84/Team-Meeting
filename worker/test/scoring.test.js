// Scoring, and the refusals that make the board worth reading.
// No network, no Cloudflare - these run anywhere.

import assert from "node:assert/strict";
import test from "node:test";

import { BadRound, RULES, cluePenalty, packSize, scoreRound } from "../src/scoring.js";

// Every pack shipped so far is twelve questions, and the tests below lean on that.
const PACK = "mixed-bag";
const SIZE = packSize(PACK);

function round(overrides = {}) {
  return { pack: PACK, right: SIZE, secondsLeft: 300, clues: [], ...overrides };
}

test("the packs came across from data/packs", () => {
  assert.equal(SIZE, 12);
  assert.equal(packSize("no-such-pack"), null);
});

test("a clean sweep collects everything there is", () => {
  const result = scoreRound(round());
  assert.equal(result.base, 1200);
  assert.equal(result.finisher, RULES.finisherBonus);
  assert.equal(result.timeBonus, 300 * RULES.pointsPerSecondRemaining);
  assert.equal(result.cleanSweep, RULES.cleanSweepBonus);
  assert.equal(result.total, 1200 + 250 + 600 + 250);
});

test("clues are taken off, and cost the clean sweep as well as their price", () => {
  const helped = scoreRound(round({ clues: ["letters"] }));
  assert.equal(helped.spent, 10);
  assert.equal(helped.cleanSweep, 0, "one clue is still a clue");
  assert.equal(helped.finisher, RULES.finisherBonus, "but the finisher survives it");
  assert.equal(helped.total, 1200 - 10 + 250 + 600);
});

test("one question short and every bonus is gone", () => {
  const result = scoreRound(round({ right: SIZE - 1 }));
  assert.equal(result.base, 1100);
  assert.deepEqual(
    [result.finisher, result.timeBonus, result.cleanSweep],
    [0, 0, 0],
    "the bonuses want a clean sheet, which is what makes reveal safe to give away free"
  );
  assert.equal(result.total, 1100);
});

test("revealing everything earns nothing at all", () => {
  // The exploit this rules out: reveal all twelve, finish with nine minutes on the
  // clock, and collect the finisher and time bonuses for a round you did not play.
  // A revealed question is never counted right, so `right` is zero and so is the lot.
  const reveals = Array.from({ length: SIZE }, () => "reveal");
  const result = scoreRound(round({ right: 0, clues: reveals, secondsLeft: 540 }));
  assert.equal(cluePenalty(reveals), 0, "reveal is free");
  assert.equal(result.total, 0);
});

test("a score that could not have been played is refused", () => {
  assert.throws(() => scoreRound(round({ right: SIZE + 1 })), BadRound, "more right than exist");
  assert.throws(() => scoreRound(round({ right: -1 })), BadRound, "a negative tally");
  assert.throws(
    () => scoreRound(round({ secondsLeft: RULES.secondsOnTheClock + 1 })),
    BadRound,
    "more clock than the round ever had"
  );
  assert.throws(() => scoreRound(round({ secondsLeft: -5 })), BadRound, "a negative clock");
  assert.throws(() => scoreRound(round({ pack: "invented" })), BadRound, "a pack nobody has");
  assert.throws(() => scoreRound(round({ right: 1.5 })), BadRound, "a fractional tally");
  assert.throws(() => scoreRound(round({ questions: 3 })), BadRound, "a pack resized in flight");
});

test("an invented clue is refused rather than priced at nothing", () => {
  assert.throws(() => cluePenalty(["freebie"]), BadRound);
  assert.throws(() => scoreRound(round({ clues: ["letters", "freebie"] })), BadRound);
});

test("more clues than the pack has to sell is refused", () => {
  const kinds = Object.keys(RULES.clueCosts).length;
  const everything = Array.from({ length: SIZE * kinds }, () => "letters");
  assert.doesNotThrow(() => scoreRound(round({ right: 0, clues: everything })));
  assert.throws(() => scoreRound(round({ right: 0, clues: everything.concat("letters") })), BadRound);
});

test("the price list is the one the browser was shown", () => {
  // data/rules.json is the original; this file is generated from it. If the two
  // ever part company the player is charged one price and ranked on another.
  assert.equal(RULES.clueCosts.reveal, 0);
  assert.equal(RULES.pointsPerQuestion, 100);
  assert.equal(RULES.secondsOnTheClock, 600);
  for (const [key, cost] of Object.entries(RULES.clueCosts)) {
    assert.ok(Number.isInteger(cost) && cost >= 0, `${key} is priced oddly: ${cost}`);
    assert.ok(cost < RULES.pointsPerQuestion, `${key} costs more than the question is worth`);
  }
});
