# Quick Fire — the 28th of September

A competitive ice breaker for a team meeting. One cartoon, nineteen things people
actually celebrate on the 28th of September, and a clue sheet you pay for out of
your own score. Everyone plays at their own pace and turns up with a number to
argue about.

```
World  _ _ B _ _ S  Day                          six letters
  Which category?                                        -10
  Fill in another letter                                 -15
  Show me where                                          -20
  What am I looking at?                                  -30
  A clue in words                                        -45
  An anagram                                             -65
  Just tell me                                free, scores 0
```

## Playing it

```bash
python scripts/build.py     # writes dist/quickfire.html
```

One file, no server, no dependencies — open it from disk, mail it round, or put it
anywhere static. Pushing to `main` publishes it to GitHub Pages.

## How the round works

- **One picture, nineteen answers.** Every one is drawn somewhere in the cartoon.
  You name the **missing word**, not the whole day: `World ___ Day` → `Rabies`.
- **The blanks start partly filled.** A couple of interior letters each — never the
  first, which would make two of the clues worthless.
- **100 points an answer.** Spelling is forgiven on longer words, accents and
  punctuation are optional, and both `neighbour` and `neighbor` count.
- **Clues cost points**, priced by how much they give away. Two of them only exist
  because the picture is a drawing the game can reach into: *show me where* rings
  the vignette, *what am I looking at* describes it. *Fill in another letter* can be
  bought as often as you like, and stops being offered once nothing is left hidden.
- **Giving up on one is free.** Revealing an answer costs nothing, but that one
  scores nothing — and it ends any hope of the bonuses.
- **The bonuses need a clean sheet.** All nineteen earns 400, and doing it without
  buying a single clue is another 400. Because both want all nineteen *found*, and a
  revealed answer is never found, "reveal the lot and collect the bonus" earns zero.
- **No clock.** The round is self-paced. A timer runs, but only to separate two
  people who finished on the same score.
- **One go.** Your first attempt is the one the leaderboard keeps.
- **Interruptions are fine.** Progress is saved as you go, so a refresh or a closed
  tab picks up where you left off.

## The picture

`app/scenes/sept-28.svg`, hand-drawn as flat vector cartoon. SVG rather than a
bitmap for three reasons: it stays inside the one self-contained HTML file, it stays
sharp at any size, and every vignette is a group the game can reach — which is the
only reason *show me where* can exist.

It is deliberately **not** numbered. Working out which drawing goes with which blank
is most of the puzzle, and printing the mapping on the picture would give away the
clue that sells it. `tests/test_round.py` fails the build if a badge ever creeps
back, if an answer gets written on the picture, or if an item has no drawing to ring.

## Writing another round

`data/rounds/<id>.json` plus a matching `app/scenes/<id>.svg`. Each item needs a
number that matches a `<g id="vig-N">` and an `<ellipse id="ring-N">` in the picture:

```json
{
  "n": 1,
  "template": "World ___ Day",
  "answer": "Rabies",
  "accept": ["hydrophobia"],
  "category": "Global & Human Rights",
  "prefill": [2, 5],
  "spot": "Bottom left: a vet holding a syringe, and one very brave dog.",
  "hint": "A disease you catch from an animal bite.",
  "note": "Shown on the results page, for the 'ah, of course' moment."
}
```

`spot` and `hint` are clues you sell; `category` is the cheapest one; `prefill` are
the letters showing at the start; `accept` adds spellings. The build refuses a round
that would play badly — a template with nowhere to put the answer, two items sharing
an answer or a number, an item with no drawing, a prefill on a space, or one that
fills in the whole word.

```bash
python scripts/generate_worker_rules.py   # tell the leaderboard how big the round is
python scripts/build.py
pytest
cd worker && npm test
```

## The leaderboard

Optional. With no address in `data/leaderboard.json` the game plays exactly the same
and makes no network calls at all.

It is a Cloudflare Worker in front of one SQLite table, and it **recalculates every
score it is sent** rather than trusting the browser — that is the only reason a
public board is worth reading. Twenty found out of nineteen, or a clue the game does
not sell, is refused. Rounds are signed at the start and the signature must come back
with the result.

One thing it deliberately does not police: how long you took. The round is
self-paced, so a browser could under-report it. The check catches someone claiming
*more* time than they had, not less — which is why time only ever breaks a tie and
never earns a point.

To switch it on:

1. Add `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit and D1:Edit) under
   **Settings → Secrets and variables → Actions**.
2. Run the **Deploy the leaderboard** workflow.
3. Put the printed `workers.dev` address into `data/leaderboard.json` and push.

No accounts and no email addresses: a player is a random id their browser keeps, plus
whatever name they type.

## Layout

```
app/
  engine.js         matching, blanks and clue building - the tested half, no DOM
  app.js            the round, the screens, the leaderboard calls
  scenes/           the pictures
data/rounds/        one file per round
data/rules.json     the scoring, written once and copied to the worker
scripts/build.py    inlines all of the above into one HTML file
worker/             the leaderboard
tests/              the round data, the picture, and the build
```

## Tests

```bash
pip install -r requirements-dev.txt && pytest
cd worker && npm install && npm test && npm run test:service
```

Every answer is checked against its own aliases, every clue against its own answer,
every item against the picture, and the leaderboard is run for real against a local
database. CI runs all of it.
