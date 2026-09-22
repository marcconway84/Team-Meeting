// The browser half of the game: matching a typed answer, the blanks, and the clue
// sheet. These run against app/engine.js directly and against the real round data,
// which is the point - a clue that cannot be built, or an answer its own alias does
// not match, is an item that breaks in someone's round rather than here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const engine = require("../../app/engine.js");

const ROUND = JSON.parse(readFileSync(new URL("../../data/rounds/2026-09-28.json", import.meta.url), "utf8"));
const SCENE = readFileSync(new URL("../../app/scenes/2026-09-28.svg", import.meta.url), "utf8");
const ITEMS = ROUND.items;

/* ------------------------------------------------------------------ matching -- */

test("every answer is matched by typing it out", () => {
  for (const item of ITEMS) {
    assert.ok(engine.answers(item.answer, item), `${item.answer} does not match itself`);
  }
});

test("every curated alias matches the item it was written for", () => {
  for (const item of ITEMS) {
    for (const alias of item.accept || []) {
      assert.ok(engine.answers(alias, item), `${alias} does not match ${item.answer}`);
    }
  }
});

test("no answer is matched by another item's answer", () => {
  // Two items one guess can satisfy would fill in the wrong row, and the generous
  // matching makes that easier to do by accident than it sounds.
  for (const item of ITEMS) {
    for (const other of ITEMS) {
      if (other === item) continue;
      assert.equal(engine.answers(other.answer, item), false,
        `"${other.answer}" also answers "${item.template}"`);
    }
  }
});

test("the spellings people actually type are accepted", () => {
  const find = (answer) => ITEMS.find((i) => i.answer === answer);
  assert.ok(engine.answers("neighbour", find("Neighbor")), "the British spelling");
  assert.ok(engine.answers("Succot", find("Sukkot")), "a different transliteration");
  assert.ok(engine.answers("mother's", find("Mothers")), "with the apostrophe");
  assert.ok(engine.answers("north carolina", find("North Carolina")), "all lower case");
  assert.ok(engine.answers("stawberry", find("Strawberry")), "a typo in a long word");
});

/* -------------------------------------------------------------------- blanks -- */

test("the blanks start partly filled and never start with the first letter", () => {
  for (const item of ITEMS) {
    const cells = engine.blanks(item, 0);
    assert.equal(cells.length, item.answer.length);
    const shown = cells.filter((c) => c.letter).length;
    assert.ok(shown >= 1, `${item.answer}: nothing filled in`);
    assert.ok(shown < engine.letterCount(item.answer), `${item.answer}: all of it is filled in`);
    assert.equal(cells[0].letter, null, `${item.answer}: the first letter is a giveaway`);
  }
});

test("spaces show as gaps, not as letters to guess", () => {
  const nc = ITEMS.find((i) => i.answer === "North Carolina");
  const cells = engine.blanks(nc, 0);
  assert.equal(cells[5].space, true);
  assert.equal(cells[5].letter, null);
});

test("each letter bought fills exactly one more blank", () => {
  const item = ITEMS.find((i) => i.answer === "Rabies");
  const count = (n) => engine.blanks(item, n).filter((c) => c.letter).length;
  assert.equal(count(1), count(0) + 1);
  assert.equal(count(2), count(0) + 2);
});

test("buying enough letters spells the answer out and then stops selling them", () => {
  const item = ITEMS.find((i) => i.answer === "Know");
  const spelled = engine.blanks(item, 10).map((c) => c.letter).join("");
  assert.equal(spelled, "KNOW");
  assert.ok(engine.fullyLettered(item, 10));
  assert.equal(engine.pictureClues(item, 10).some((c) => c.key === "letter"), false,
    "there is nothing left to fill in, so it must not still be on sale");
});

/* ---------------------------------------------------------------- clue sheet -- */

test("every item builds a full clue sheet", () => {
  for (const item of ITEMS) {
    const sheet = engine.pictureClues(item, 0);
    const keys = sheet.map((c) => c.key);
    for (const needed of ["category", "letter", "spot", "hint", "reveal"]) {
      assert.ok(keys.includes(needed), `${item.answer}: no ${needed} clue`);
    }
    assert.equal(new Set(keys).size, keys.length, `${item.answer}: a clue offered twice`);
    for (const clue of sheet) {
      if (clue.reveal || clue.ring || clue.repeatable) continue;
      assert.ok(clue.give && String(clue.give).trim(), `${item.answer}: ${clue.key} came back empty`);
    }
  }
});

test("no clue simply hands over the answer", () => {
  // The trap this catches: a "first word" style clue on a one-word answer, which
  // would be a reveal sold at full price.
  for (const item of ITEMS) {
    for (const clue of engine.pictureClues(item, 0)) {
      if (!clue.give) continue;
      assert.notEqual(String(clue.give).toLowerCase(), item.answer.toLowerCase(),
        `${item.answer}: the ${clue.key} clue is the answer`);
    }
  }
});

test("the anagram is stable, and is never the answer in order", () => {
  for (const item of ITEMS) {
    const sheet = engine.pictureClues(item, 0);
    const anagram = sheet.find((c) => c.key === "anagram");
    if (!anagram) continue;
    assert.equal(anagram.give, engine.clueAnagram(item), "it changed between renders");
    assert.notEqual(anagram.give.replace(/ /g, ""),
      item.answer.toUpperCase().replace(/[^A-Z0-9]/g, ""), `${item.answer}: the anagram is the answer`);
  }
});

test("the length note counts letters, not spaces", () => {
  assert.equal(engine.lengthNote("Rabies"), "six letters");
  assert.equal(engine.lengthNote("North Carolina"), "two words, thirteen letters");
});

/* ------------------------------------------------------------------- picture -- */

test("every item is actually in the picture", () => {
  // "Show me where" charges 20 points to ring a vignette. If the group or its ring
  // is missing the player pays for nothing at all.
  for (const item of ITEMS) {
    assert.ok(SCENE.includes(`id="vig-${item.n}"`), `no drawing for item ${item.n} (${item.answer})`);
    assert.ok(SCENE.includes(`class="badge-no">${item.n}<`), `no number for item ${item.n} (${item.answer})`);
  }
});

test("the picture numbers its drawings but names none of them", () => {
  assert.ok(SCENE.includes("badge-no"), "the vignettes must be numbered");
  for (const item of ITEMS) {
    assert.equal(SCENE.toLowerCase().includes(">" + item.answer.toLowerCase() + "<"), false,
      `${item.answer} is written on the picture`);
  }
});

test("no rings are left over", () => {
  // They pointed at a vignette for the "show me where" clue, which is gone.
  assert.equal(SCENE.includes("ring-"), false);
});

/* ------------------------------------------------------------------ the day -- */

// The series is announced before it opens and people follow the link early, so
// what a date before the first round shows is a real question, not a corner case.
const SERIES = [
  { id: "2026-09-28", date: "2026-09-28" },
  { id: "2026-09-29", date: "2026-09-29" },
  { id: "2026-10-01", date: "2026-10-01" },
];

test("before the series opens, the opening round is the one on show", () => {
  assert.equal(engine.roundForDate(SERIES, "2026-09-22").date, "2026-09-28");
  assert.equal(engine.roundForDate(SERIES, "2026-09-27").date, "2026-09-28");
});

test("once it has opened, the date decides", () => {
  assert.equal(engine.roundForDate(SERIES, "2026-09-28").date, "2026-09-28");
  assert.equal(engine.roundForDate(SERIES, "2026-09-29").date, "2026-09-29");
  assert.equal(engine.roundForDate(SERIES, "2026-10-01").date, "2026-10-01");
});

test("a gap holds on the last round rather than showing nothing", () => {
  // The 30th has no round of its own; the 29th is still the current one.
  assert.equal(engine.roundForDate(SERIES, "2026-09-30").date, "2026-09-29");
  // And after the series ends it stays on the final round.
  assert.equal(engine.roundForDate(SERIES, "2026-12-25").date, "2026-10-01");
});

test("the order rounds are listed in does not decide which one is shown", () => {
  const shuffled = [SERIES[2], SERIES[0], SERIES[1]];
  assert.equal(engine.roundForDate(shuffled, "2026-09-22").date, "2026-09-28");
  assert.equal(engine.roundForDate(shuffled, "2026-09-29").date, "2026-09-29");
});

test("the picker is never empty, and never offers a day that has not happened", () => {
  // Before the off it still lists the round being shown; a picker missing the
  // round in front of you reads like a bug.
  assert.deepEqual(engine.playableOn(SERIES, "2026-09-22").map((r) => r.date), ["2026-09-28"]);
  // Afterwards, newest first, and nothing from the future.
  assert.deepEqual(engine.playableOn(SERIES, "2026-09-29").map((r) => r.date),
    ["2026-09-29", "2026-09-28"]);
  assert.deepEqual(engine.playableOn(SERIES, "2026-10-01").map((r) => r.date),
    ["2026-10-01", "2026-09-29", "2026-09-28"]);
});

test("an empty series does not throw", () => {
  assert.equal(engine.roundForDate([], "2026-09-22"), null);
  assert.deepEqual(engine.playableOn([], "2026-09-22"), []);
});

/* ---------------------------------------------------------------- wording -- */

test("no round writes its own size into its prose", () => {
  // The briefing used to say "nineteen" while the count worked out from the
  // round said twenty. The round was right; the sentence was not. Counts belong
  // in the tally, which cannot disagree with the round it is counting.
  const words = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b\s+(answers|reasons|things|items|blanks|words)/i;
  for (const field of ["title", "subject", "blurb"]) {
    const text = String(ROUND[field] || "");
    assert.equal(words.test(text), false, `${field} states a count: ${text}`);
    assert.equal(/\b\d+\s+(answers|reasons|things|items|blanks|words)\b/i.test(text), false,
      `${field} states a count: ${text}`);
  }
});
