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

const ROUND = JSON.parse(readFileSync(new URL("../../data/rounds/sept-28.json", import.meta.url), "utf8"));
const SCENE = readFileSync(new URL("../../app/scenes/sept-28.svg", import.meta.url), "utf8");
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
    for (const needed of ["category", "letter", "where", "spot", "hint", "reveal"]) {
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
    assert.ok(SCENE.includes(`id="ring-${item.n}"`), `no ring for item ${item.n} (${item.answer})`);
  }
});

test("the picture gives nothing away for free", () => {
  // No numbered badges: the mapping from drawing to blank is what "show me where"
  // sells, so printing it on the picture would make that clue worthless.
  assert.equal(SCENE.includes("badge-no"), false, "the vignettes are numbered again");
  for (const item of ITEMS) {
    assert.equal(SCENE.toLowerCase().includes(">" + item.answer.toLowerCase() + "<"), false,
      `${item.answer} is written on the picture`);
  }
});

test("every ring is switched off until it is bought", () => {
  assert.equal(/class="ring on"/.test(SCENE), false, "a ring ships already lit");
});
