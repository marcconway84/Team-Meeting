# Red Letter Day

*A red-letter day is one worth marking. Every answer in this game is one - and the
letters filled in for you are red.*

A competitive ice breaker for a team meeting. One cartoon, nineteen things people
actually celebrate on the 28th of September, and a clue sheet you pay for out of
your own score.

Everyone plays **at the same time**. The host starts the clock, the room gets five
minutes, and when it stops it stops for all of them and the table goes up.

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
python scripts/build.py     # writes dist/red-letter-day.html
```

One file, no server, no dependencies — open it from disk, mail it round, or put it
anywhere static. Pushing to `main` publishes it to GitHub Pages.

## Running a game

1. **Everyone opens the link** and puts a name in. They land in a lobby that counts
   heads as people arrive.
2. **You open it with `?host=<key>`.** That is the only difference between you and
   them: a dashed box with a start button. Players never see it.
3. **Press start.** Within a couple of seconds every screen in the room flips to the
   picture with 5:00 on it. The clock belongs to the server, so everyone is counting
   down to the same instant regardless of what their own laptop thinks the time is.
4. **They play.** Each answer tells them where they have just landed — "3rd of 11" —
   and the place sits in the header next to the score for the rest of the round.
5. **Time stops for everybody at once** and the same final table appears on every
   screen.

**New game** clears the room and puts everyone back in the lobby.

## How the round works

- **One picture, nineteen answers.** Every one is drawn somewhere in the cartoon.
  You name the **missing word**, not the whole day: `World ___ Day` → `Rabies`.
- **The blanks start partly filled.** A couple of interior letters each — never the
  first, which would make two of the clues worthless.
- **100 points an answer.** Spelling is forgiven on longer words, accents and
  punctuation are optional, and both `neighbour` and `neighbor` count.
- **The numbers match.** Each drawing carries a number, and it is the number of the
  blank it answers. They were not numbered once, and the round was too hard for it.
- **Clues cost points**, priced by how much they give away. *What am I looking at*
  describes the drawing in words. *Fill in another letter* can be bought as often as
  you like, and stops being offered once nothing is left hidden.
- **Giving up on one is free.** Revealing an answer costs nothing, but that one
  scores nothing — and it ends any hope of the bonuses.
- **The bonuses need a clean sheet.** All nineteen earns 400, and doing it without
  buying a single clue is another 400. In five minutes, good luck.
- **Interruptions are survivable.** Progress is saved as you go and posted to the
  server on every answer, so a closed tab or a dead battery keeps its score.

## Installing it

The page declares a manifest and registers a service worker, so on a phone it can be
added to the home screen and opens without browser furniture. The worker caches the
page and its icons and nothing else - the game server is never cached, because a
leaderboard served from yesterday is worse than none and a shared clock read from a
cache is not a clock. The cache name carries a hash of the built page, so an
installed copy picks up a new round rather than serving the old one for ever.

## The picture

`app/scenes/<round>.svg`, hand-drawn as flat vector cartoon. SVG rather than a
bitmap for three reasons: it stays inside the one self-contained HTML file, it stays
sharp at any size, and every vignette is a group the game can reach — which is the
only reason *show me where* can exist.

Every vignette is numbered, and the number is the number of the blank it answers.
It was not, at first: working out which drawing went with which blank was meant to be
part of the puzzle, and in practice it made the round too hard. The clue that sold
you the mapping went with the change. `tests/test_round.py` fails the build if an
item has no drawing, if a drawing is not numbered, or if an answer gets written on
the picture.

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

## The game server

**Not optional any more.** A shared clock and a live table need somewhere shared to
keep them. With no address in `data/leaderboard.json` the page says so plainly and
falls back to a solo five minutes against nobody.

It is a Cloudflare Worker in front of two small tables — one game, one row per
player. It owns three things worth owning:

- **The clock.** The host sets an end time; everybody else is told what it is. Every
  reply also carries the server's own `now`, so each client measures how far its own
  clock is out and counts down against ours. A laptop three minutes fast does not
  get a three minute shorter game.
- **The arithmetic.** A client says how many it has found and which clues it bought;
  the score is worked out on the server. Posting a made-up total changes nothing,
  and a score that could not have happened — twenty found out of nineteen, a clue
  the game does not sell — is refused outright.
- **The start button.** Guarded by a host key. Without it you get a 403.

What it deliberately does **not** do is check that an answer was really right. That
would mean holding the answers on the server and round-tripping every keystroke, and
the answers are readable in the page source anyway. This is an ice breaker; the
person who opens the console to win has already lost.

To switch it on:

1. Add `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit and D1:Edit) under
   **Settings → Secrets and variables → Actions**. Optionally add `HOST_KEY` too —
   otherwise one is generated and printed to the workflow summary.
2. Run the **Deploy the game server** workflow. It creates the database, applies the
   schema, and plays a whole game through the live service before calling it done.
3. Put the printed `workers.dev` address into `data/leaderboard.json` and push.

No accounts and no email addresses: a player is a random id their browser made up,
plus whatever name they typed.

## Layout

```
app/
  engine.js         matching, blanks and clue building - the tested half, no DOM
  app.js            the round, the screens, the leaderboard calls
  scenes/           the pictures
data/rounds/        one file per round
data/rules.json     the scoring, written once and copied to the worker
scripts/build.py    inlines all of the above into one HTML file
worker/             the game server: the clock, the room and the table
tests/              the round data, the picture, and the build
```

## Tests

```bash
pip install -r requirements-dev.txt && pytest
cd worker && npm install && npm test && npm run test:service
```

Every answer is checked against its own aliases, every clue against its own answer,
and every item against the picture. The service tests run a real worker against a
real database and play a whole game through it: the lobby, the host key, one clock
for everybody, overtaking, an impossible score, the whistle, and the fact that a
point posted afterwards does not move the table. CI runs all of it.
