#!/usr/bin/env python3
"""Build Red Letter Day: the rounds, the rules and the client in one HTML file.

The game has no server of its own. A pack is data, the rules are data, and the
game is a few hundred lines of browser JavaScript - so the build is one step:
read app/index.html, app/styles.css, app/engine.js and app/app.js, drop the packs
and the rules into the script, and write a single file that can be opened from
disk, mailed round, or served from GitHub Pages.

    python scripts/build.py                 -> dist/red-letter-day.html
    python scripts/build.py --site          -> dist/site/ for Pages

Validation happens here rather than at run time: a malformed pack fails the
build, which is the last moment anyone is watching. tests/test_packs.py runs the
same checks against everything in data/packs/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ROUND_DIR = REPO_ROOT / "data" / "rounds"
SCENE_DIR = REPO_ROOT / "app" / "scenes"
PACK_DIR = REPO_ROOT / "data" / "packs"
RULES = REPO_ROOT / "data" / "rules.json"
LEADERBOARD = REPO_ROOT / "data" / "leaderboard.json"
SOURCE = REPO_ROOT / "app"
WEB = REPO_ROOT / "web"
DEFAULT_OUT = REPO_ROOT / "dist" / "red-letter-day.html"

TITLE = "Red Letter Day &mdash; the quiz of what today is for"
BLURB = ("One cartoon, every reason today is somebody's red letter day, and a clue sheet "
         "you pay for out of your own score. Play it with the room or on your own.")
SITE_URL = "https://marcconway84.github.io/Team-Meeting/"

#: Every key the game knows how to price. A pack cannot invent a new one, and a
#: rules file that forgets one would leave a clue the game cannot charge for.
CLUE_KEYS = {"category", "letter", "spot", "hint", "anagram", "reveal"}

#: Below this the clue sheet stops being a ladder - an anagram of three letters
#: is the answer with extra steps.
MIN_ANSWER_LETTERS = 3
MIN_ITEMS = 6


class BadPack(Exception):
    """A pack that would make a broken game. Raised at build time, never at play time."""


def load_rules() -> dict:
    rules = json.loads(RULES.read_text(encoding="utf-8"))
    picture = rules.get("picture")
    if not isinstance(picture, dict):
        raise BadPack(f"{RULES.name} has no picture-round rules")

    missing = CLUE_KEYS - set(picture.get("clueCosts", {}))
    if missing:
        raise BadPack(f"{RULES.name} has no price for: {', '.join(sorted(missing))}")
    unknown = set(picture["clueCosts"]) - CLUE_KEYS
    if unknown:
        raise BadPack(f"{RULES.name} prices clues the game does not offer: {', '.join(sorted(unknown))}")
    for key in ("pointsPerItem", "finisherBonus", "cleanSweepBonus"):
        if not isinstance(picture.get(key), int):
            raise BadPack(f"{RULES.name} is missing a whole number for picture.{key}")
    # A clue dearer than the thing it helps you win is a clue nobody sane buys.
    for key, cost in picture["clueCosts"].items():
        if not isinstance(cost, int) or not 0 <= cost < picture["pointsPerItem"]:
            raise BadPack(f"{RULES.name}: the {key} clue is priced at {cost}")
    return {key: value for key, value in rules.items() if not key.startswith("_")}


def check_round(round_data: dict) -> dict:
    """Refuse a picture round that would play badly, and say exactly which item."""
    for field in ("id", "date", "title", "subject", "scene", "items"):
        if not round_data.get(field):
            raise BadPack(f"the round is missing {field}")

    try:
        date.fromisoformat(round_data["date"])
    except ValueError as err:
        raise BadPack(f"{round_data['id']}: {round_data['date']!r} is not a date") from err

    # Rounds vary in length - some days simply have more going on than others -
    # but one or two items is not a round, and the picture would be mostly empty.
    if len(round_data["items"]) < MIN_ITEMS:
        raise BadPack(f"{round_data['id']}: only {len(round_data['items'])} items; "
                      f"{MIN_ITEMS} is the fewest worth playing")

    scene = SCENE_DIR / f"{round_data['scene']}.svg"
    if not scene.exists():
        raise BadPack(f"the round names a picture that does not exist: {scene.name}")
    drawing = scene.read_text(encoding="utf-8")

    seen_answers: set[str] = set()
    seen_numbers: set[int] = set()
    for item in round_data["items"]:
        at = f"item {item.get('n', '?')}: "
        for field in ("n", "template", "answer", "category", "spot"):
            if not item.get(field):
                raise BadPack(at + f"missing {field}")
        if "___" not in item["template"]:
            raise BadPack(at + "the template has no ___ for the answer to go in")

        answer = item["answer"]
        if answer.lower() in seen_answers:
            raise BadPack(at + f"{answer!r} is already the answer to another item")
        seen_answers.add(answer.lower())
        if item["n"] in seen_numbers:
            raise BadPack(at + "two items share a number")
        seen_numbers.add(item["n"])

        # Every item needs a drawing and, on it, the number that says which blank
        # it answers. Without the number it is an item nobody can place.
        if f'id="vig-{item["n"]}"' not in drawing:
            raise BadPack(at + f'the picture has no id="vig-{item["n"]}"')
        if f'class="badge-no">{item["n"]}<' not in drawing:
            raise BadPack(at + f"the picture does not number this one {item['n']}")

        prefill = item.get("prefill") or []
        if not prefill:
            raise BadPack(at + "no letters are filled in to start with")
        for index in prefill:
            if not isinstance(index, int) or not 0 <= index < len(answer):
                raise BadPack(at + f"prefill {index} is outside {answer!r}")
            if answer[index] == " ":
                raise BadPack(at + f"prefill {index} points at a space")
        hidden = [i for i in range(len(answer)) if i not in prefill and answer[i] != " "]
        if not hidden:
            raise BadPack(at + "every letter is filled in already")

    return round_data


def load_rounds() -> list[dict]:
    """Every round, oldest first, each checked before it can reach anybody.

    Keyed by date, because the date is the theme: a round is the things people
    celebrate on that day. Today's is picked in the browser from this list, and
    the rest stay playable so somebody who missed a day can still catch up.
    """
    if not ROUND_DIR.is_dir():
        raise BadPack(f"no rounds: {ROUND_DIR} does not exist")

    rounds: list[dict] = []
    ids: set[str] = set()
    dates: set[str] = set()
    for path in sorted(ROUND_DIR.glob("*.json")):
        data = check_round(json.loads(path.read_text(encoding="utf-8")))
        if data["id"] in ids:
            raise BadPack(f"{path.name}: the id {data['id']!r} is used by another round")
        if data["date"] in dates:
            raise BadPack(f"{path.name}: {data['date']} already has a round")
        ids.add(data["id"])
        dates.add(data["date"])
        rounds.append(data)
    if not rounds:
        raise BadPack(f"no rounds found in {ROUND_DIR}")
    return sorted(rounds, key=lambda r: r["date"])


def load_scenes(rounds: list[dict]) -> dict[str, str]:
    """The pictures, keyed by the name the rounds ask for them by.

    One copy each even when two rounds share a picture, because the whole lot is
    inlined into a single file and a duplicated drawing is a duplicated 60KB.
    """
    return {
        name: (SCENE_DIR / f"{name}.svg").read_text(encoding="utf-8")
        for name in sorted({r["scene"] for r in rounds})
    }


def check_pack(pack: dict, source: str) -> dict:
    """Refuse a pack that would play badly, and say which one and why."""
    where = f"{source}: "
    for field in ("id", "title", "subject", "questions"):
        if not pack.get(field):
            raise BadPack(where + f"missing {field}")

    questions = pack["questions"]
    if len(questions) < MIN_QUESTIONS:
        raise BadPack(where + f"only {len(questions)} questions; {MIN_QUESTIONS} is the minimum")

    seen_prompts: set[str] = set()
    seen_answers: set[str] = set()
    for index, question in enumerate(questions, start=1):
        at = where + f"question {index}: "
        prompt = str(question.get("prompt") or "").strip()
        answer = str(question.get("answer") or "").strip()
        if not prompt:
            raise BadPack(at + "no prompt")
        if not answer:
            raise BadPack(at + "no answer")
        if len(answer.replace(" ", "")) < MIN_ANSWER_LETTERS:
            raise BadPack(at + f"the answer {answer!r} is too short to build clues from")
        if prompt.lower() in seen_prompts:
            raise BadPack(at + "the same question is already in this pack")
        seen_prompts.add(prompt.lower())

        # Two questions with one answer is a real trap: the wrong tile lights up
        # when the second is answered, and the multiple-choice clue can offer the
        # right answer twice.
        key = answer.lower()
        if key in seen_answers:
            raise BadPack(at + f"{answer!r} is already the answer to another question in this pack")
        seen_answers.add(key)

        decoys = question.get("decoys") or []
        if decoys and len(decoys) < 3:
            raise BadPack(at + f"{len(decoys)} decoys; give three or none at all")
        if key in {str(d).lower() for d in decoys}:
            raise BadPack(at + "the answer is one of its own decoys")

    return pack


def load_packs() -> list[dict]:
    if not PACK_DIR.is_dir():
        raise BadPack(f"no packs: {PACK_DIR} does not exist")
    packs: list[dict] = []
    ids: set[str] = set()
    for path in sorted(PACK_DIR.glob("*.json")):
        pack = check_pack(json.loads(path.read_text(encoding="utf-8")), path.name)
        if pack["id"] in ids:
            raise BadPack(f"{path.name}: the id {pack['id']!r} is used by another pack")
        ids.add(pack["id"])
        packs.append({
            "id": pack["id"],
            "title": pack["title"],
            "subject": pack["subject"],
            "blurb": pack.get("blurb", ""),
            "questions": [
                {
                    "prompt": q["prompt"],
                    "answer": q["answer"],
                    "accept": q.get("accept", []),
                    "hint": q.get("hint"),
                    "decoys": q.get("decoys", []),
                    "note": q.get("note"),
                }
                for q in pack["questions"]
            ],
        })
    if not packs:
        raise BadPack(f"no packs found in {PACK_DIR}")
    return packs


def leaderboard_payload() -> str:
    """Where the board lives, or null. Built in, so a board-less page makes no calls."""
    if not LEADERBOARD.exists():
        return "null"
    config = json.loads(LEADERBOARD.read_text(encoding="utf-8"))
    url = str(config.get("url") or "").strip()
    if not url:
        return "null"
    # Loopback is allowed so the game can be driven against a local server during
    # development; anything else has to be https, because the page is.
    if not url.startswith("https://") and not url.startswith("http://127.0.0.1"):
        raise BadPack(f"leaderboard url must be https, got {url!r}")
    return json.dumps({"url": url.rstrip("/")})


def embed(value) -> str:
    """JSON for a <script> block: a literal </ would close the block early."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def build() -> str:
    rounds = load_rounds()
    rules = load_rules()

    # The engine goes first: app.js reads the global it publishes.
    engine = (SOURCE / "engine.js").read_text(encoding="utf-8")
    script = engine + "\n" + (SOURCE / "app.js").read_text(encoding="utf-8")
    script = script.replace("__ROUNDS__", embed(rounds))
    script = script.replace("__SCENES__", embed(load_scenes(rounds)))
    script = script.replace("__RULES__", embed(rules))
    script = script.replace("__LEADERBOARD__", leaderboard_payload())

    markup = (SOURCE / "index.html").read_text(encoding="utf-8")
    styles = (SOURCE / "styles.css").read_text(encoding="utf-8")

    # Stamped over the finished script, so the mark moves whenever anything in the
    # page does - a question, a price, the board's address, any of it.
    build_mark = hashlib.sha256(script.encode("utf-8")).hexdigest()[:8]
    markup = markup.replace("__BUILD__", f"build {build_mark}")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="description" content="{BLURB}" />
<meta name="theme-color" content="#0a0f1a" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Red Letter Day" />
<meta property="og:title" content="Red Letter Day" />
<meta property="og:description" content="{BLURB}" />
<meta property="og:url" content="{SITE_URL}" />
<meta name="twitter:card" content="summary" />
<!-- Installable: added to a home screen it opens without browser furniture. -->
<link rel="manifest" href="manifest.webmanifest" />
<link rel="icon" href="icon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="icon-180.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Red Letter" />
<title>{TITLE}</title>
<style>
{styles}
</style>
</head>
<body>
{markup}
<script>
{script}
</script>
<script>
if ("serviceWorker" in navigator) {{
  window.addEventListener("load", function () {{
    navigator.serviceWorker.register("sw.js").catch(function () {{ /* offline play unavailable */ }});
  }});
}}
</script>
</body>
</html>
"""


def build_site(out_dir: Path) -> None:
    """The page plus what makes it installable: a manifest, icons, a worker."""
    out_dir.mkdir(parents=True, exist_ok=True)
    page = build()
    (out_dir / "index.html").write_text(page, encoding="utf-8")

    for asset in sorted(WEB.iterdir()):
        if asset.is_file():
            shutil.copy2(asset, out_dir / asset.name)

    # Stamp the service worker with a hash of the page. It serves from its cache
    # when offline, so without a new cache name an installed copy would go on
    # showing an old round after every update.
    digest = hashlib.sha256(page.encode("utf-8")).hexdigest()[:12]
    worker = out_dir / "sw.js"
    worker.write_text(
        worker.read_text(encoding="utf-8").replace('"redletter-v1"', f'"redletter-{digest}"'),
        encoding="utf-8",
    )
    # Pages otherwise runs the upload through Jekyll, which ignores some files.
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")
    print(f"Wrote {out_dir}/ ({sum(1 for _ in out_dir.iterdir())} files), cache redletter-{digest}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", action="store_true",
                        help="build into dist/site/ for publishing")
    parser.add_argument("-o", "--out", type=Path, default=None)
    args = parser.parse_args()

    try:
        if args.site:
            build_site(args.out or (REPO_ROOT / "dist" / "site"))
            return 0
        out = args.out or DEFAULT_OUT
        out.parent.mkdir(parents=True, exist_ok=True)
        html = build()
        out.write_text(html, encoding="utf-8")
        print(f"Wrote {out} ({len(html) / 1024:.0f} KB)")
    except BadPack as err:
        print(f"error: {err}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
