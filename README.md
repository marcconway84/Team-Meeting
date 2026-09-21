# Quick Fire

A competitive ice breaker for a team meeting. Twelve questions, ten minutes, and a
clue sheet you pay for out of your own score. People play whenever suits them and
turn up with a number to argue about.

```
QUICK FIRE                           TIME 7:42   SCORE 480   RIGHT 5/12
[1][2][3][4][5][6][7][8][9][10][11][12]

QUESTION 6 OF 12                                    100 POINTS, 30 SPENT
Which gas do plants absorb from the air?

  How long is it?       13 letters across two words (6, 7).      -10
  The first letter      Begins with C.                           -20
  The initials                                                   -30
  A clue in words                                                -45
  Vowels removed                                                 -55
  An anagram                                                     -65
  Four to choose from                                            -75
  Just tell me                                        free, scores 0
```

## Playing it

```bash
python scripts/build.py     # writes dist/quickfire.html
```

One file, no server, no dependencies &mdash; open it from disk, mail it round, or
put it anywhere static. Pushing to `main` publishes it to GitHub Pages.

## How the game works

- **One clock, twelve questions.** Ten minutes for the whole round, not one per
  question, so you can skip the hard ones and come back. The strip of numbers at the
  top jumps you between them.
- **100 points a question.** Answers are matched generously: case, accents and
  punctuation are optional (`Pique` finds `Piqué`), a leading "the" is ignored either
  way, and a typo or two is forgiven on anything long enough to mistype. Short
  answers must be exact.
- **Clues cost points,** priced by how much they give away: the number of letters
  (&minus;10), the first letter (&minus;20), the initials (&minus;30), a written hint
  (&minus;45), the vowels removed (&minus;55), an anagram (&minus;65), four options
  to choose from (&minus;75).
- **Giving up on one is free.** Revealing an answer costs nothing, but that question
  scores nothing &mdash; and it ends any hope of the bonuses.
- **The bonuses need a clean sheet.** All twelve right earns 250, plus 2 a second for
  whatever is left on the clock. Do it without buying a single clue and that is
  another 250. Because every bonus wants all twelve *right*, and a revealed answer is
  never right, "reveal the lot and collect the finisher bonus" earns nothing at all.
- **One go at each pack.** Your first attempt is the one the leaderboard keeps.
- **Interruptions are fine.** The round is saved as you go and the clock is a
  deadline rather than a countdown, so closing the tab does not pause it and a
  refresh picks up where you left off.

**Clues are computed, not written.** The anagram is generated, the vowels stripped,
the initials read off. So writing a pack is a list of questions and answers, and the
whole clue sheet comes with it &mdash; it cannot go stale, and
`worker/test/engine.test.js` checks every clue against every answer in every pack. A
clue that would say nothing is left off: no initials on a one word answer.

## Writing a pack

One file in `data/packs/`. The id is what the leaderboard keys on, and everything
past `prompt` and `answer` is optional:

```json
{
  "id": "your-subject",
  "title": "Your Subject",
  "subject": "What it is about",
  "blurb": "One line for the pack list.",
  "questions": [
    {
      "prompt": "Which gas do plants absorb from the air?",
      "answer": "Carbon dioxide",
      "accept": ["co2"],
      "hint": "Two words. You breathe it out.",
      "decoys": ["Oxygen", "Nitrogen", "Methane"],
      "note": "Shown on the results page, for the 'ah, of course' moment."
    }
  ]
}
```

`accept` adds aliases, `hint` is the one clue that cannot be computed, `decoys` are
the three wrong options (without them the game borrows other answers from the pack,
which works but reads oddly), and `note` is the bit of colour shown afterwards.

Aim for answers of one to four words, and avoid bare numbers &mdash; "begins with F"
is a poor clue for `Four`. The build refuses a pack that would play badly: too few
questions, a repeated question, two questions sharing an answer, an answer too short
to make clues from, or a half-written decoy set.

```bash
python scripts/generate_worker_rules.py   # tell the leaderboard how long the pack is
python scripts/build.py
pytest
cd worker && npm test
```

## The leaderboard

Optional. With no address in `data/leaderboard.json` the game plays exactly the same
and makes no network calls at all.

It is a Cloudflare Worker in front of one SQLite table, and it **recalculates every
score it is sent** rather than trusting the browser &mdash; that is the only reason a
public board is worth reading. A round claiming thirteen right out of twelve, or more
clock than the round ever had, is refused. Rounds are signed at the start and the
signature must come back with the result, so a score has to at least wait out a
plausible amount of clock.

To switch it on:

1. Add `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit and D1:Edit) under
   **Settings → Secrets and variables → Actions**.
2. Run the **Deploy the leaderboard** workflow. It creates the database, applies the
   schema, invents a signing secret and smoke-tests the live service.
3. Put the printed `workers.dev` address into `data/leaderboard.json` and push.

No accounts and no email addresses: a player is a random id their browser keeps, plus
whatever name they type.

## Layout

```
app/                the game in the browser
  engine.js         matching and clue building - the tested half, no DOM
  app.js            the round, the screens, the leaderboard calls
data/packs/         one file per pack
data/rules.json     the scoring, written once and copied to the worker
scripts/build.py    inlines all of the above into one HTML file
worker/             the leaderboard
tests/              the packs and the build
```

## Tests

```bash
pip install -r requirements-dev.txt && pytest
cd worker && npm install && npm test && npm run test:service
```

The packs are checked against the rules that make a pack playable, every answer is
checked against its own aliases and every clue against its own answer, and the
leaderboard is run for real against a local database. CI runs all of it.
