"""The round, the picture, the build, and the copy of the rules the board uses.

The game itself runs in the browser and is tested there - worker/test/engine.test.js
checks matching, the blanks and the clue sheet against the real round, and
worker/test/scoring.test.js checks the scoring. What is left for Python is the part
Python owns: that the round data cannot be malformed, that the page builds with
everything in it, and that the price list the browser is handed is the one the
leaderboard charges.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
ROUND_FILE = REPO_ROOT / "data" / "rounds" / "sept-28.json"
SCENE_FILE = REPO_ROOT / "app" / "scenes" / "sept-28.svg"
RULES_FILE = REPO_ROOT / "data" / "rules.json"
GENERATED = REPO_ROOT / "worker" / "src" / "rules.generated.json"


@pytest.fixture(scope="module")
def build():
    spec = importlib.util.spec_from_file_location("build", REPO_ROOT / "scripts" / "build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def round_data() -> dict:
    return json.loads(ROUND_FILE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def scene() -> str:
    return SCENE_FILE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def page(build) -> str:
    return build.build()


def _round(**overrides) -> dict:
    """A minimal round that passes, so each test can break exactly one thing."""
    base = {
        "id": "test-round",
        "title": "Test",
        "subject": "Testing",
        "scene": "sept-28",
        "items": [
            {"n": 1, "template": "World ___ Day", "answer": "Rabies",
             "category": "Global & Human Rights", "spot": "A dog.", "prefill": [2]},
        ],
    }
    base.update(overrides)
    return base


class TestTheRound:
    def test_it_is_well_formed(self, build, round_data):
        build.check_round(round_data)

    def test_nineteen_items(self, round_data):
        assert len(round_data["items"]) == 19

    def test_every_item_has_somewhere_to_put_the_answer(self, round_data):
        for item in round_data["items"]:
            assert "___" in item["template"], item["template"]

    def test_answers_are_short_enough_to_type(self, round_data):
        for item in round_data["items"]:
            assert len(item["answer"].split()) <= 3, item["answer"]

    def test_no_answer_is_a_bare_number(self, round_data):
        # "Begins with F" is a poor clue for "Four", and an anagram of it is worse.
        for item in round_data["items"]:
            assert not item["answer"].isdigit(), item["answer"]

    def test_every_item_has_a_way_to_be_found_in_the_picture(self, round_data):
        for item in round_data["items"]:
            assert item["spot"].strip(), item["answer"]

    def test_the_categories_are_the_four_advertised(self, round_data):
        allowed = {"Global & Human Rights", "Lifestyle & Community",
                   "Food & Beverage", "Quirky & Educational"}
        for item in round_data["items"]:
            assert item["category"] in allowed, item["category"]

    def test_sukkot_made_it_in(self, round_data):
        answers = {item["answer"] for item in round_data["items"]}
        assert "Sukkot" in answers


class TestTheBlanksAreSetUpFairly:
    def test_something_is_filled_in_and_something_is_not(self, round_data):
        for item in round_data["items"]:
            answer = item["answer"]
            prefill = item["prefill"]
            assert prefill, f"{answer}: nothing filled in"
            hidden = [i for i in range(len(answer)) if i not in prefill and answer[i] != " "]
            assert hidden, f"{answer}: every letter is filled in"

    def test_the_first_letter_is_never_given_away(self, round_data):
        # Otherwise nineteen first letters are free, and buying a letter is a worse deal.
        for item in round_data["items"]:
            assert 0 not in item["prefill"], item["answer"]

    def test_no_prefill_points_at_a_space(self, round_data):
        for item in round_data["items"]:
            for index in item["prefill"]:
                assert item["answer"][index] != " ", item["answer"]

    def test_at_most_a_third_of_a_word_is_given(self, round_data):
        for item in round_data["items"]:
            letters = len(item["answer"].replace(" ", ""))
            assert len(item["prefill"]) <= max(1, letters // 3), item["answer"]


class TestABadRoundFailsTheBuild:
    """Every one of these would otherwise be found by a player, mid-round."""

    def test_a_template_with_no_gap_is_refused(self, build):
        bad = _round()
        bad["items"][0]["template"] = "World Rabies Day"
        with pytest.raises(build.BadPack, match="no ___"):
            build.check_round(bad)

    def test_two_items_with_one_answer_are_refused(self, build):
        bad = _round()
        bad["items"].append(dict(bad["items"][0], n=2))
        with pytest.raises(build.BadPack, match="already the answer"):
            build.check_round(bad)

    def test_two_items_sharing_a_number_are_refused(self, build):
        bad = _round()
        bad["items"].append(dict(bad["items"][0], answer="Hunger"))
        with pytest.raises(build.BadPack, match="share a number"):
            build.check_round(bad)

    def test_an_item_missing_from_the_picture_is_refused(self, build):
        # It would sell "show me where" for 20 points and then ring nothing.
        bad = _round()
        bad["items"][0]["n"] = 99
        with pytest.raises(build.BadPack, match="no id=\"vig-99\""):
            build.check_round(bad)

    def test_a_picture_that_does_not_exist_is_refused(self, build):
        with pytest.raises(build.BadPack, match="picture that does not exist"):
            build.check_round(_round(scene="no-such-scene"))

    def test_no_prefilled_letters_is_refused(self, build):
        bad = _round()
        bad["items"][0]["prefill"] = []
        with pytest.raises(build.BadPack, match="no letters are filled in"):
            build.check_round(bad)

    def test_a_prefill_on_a_space_is_refused(self, build):
        bad = _round()
        bad["items"][0]["answer"] = "North Carolina"
        bad["items"][0]["prefill"] = [5]
        with pytest.raises(build.BadPack, match="points at a space"):
            build.check_round(bad)

    def test_giving_the_whole_answer_away_is_refused(self, build):
        bad = _round()
        bad["items"][0]["prefill"] = [0, 1, 2, 3, 4, 5]
        with pytest.raises(build.BadPack, match="every letter is filled in"):
            build.check_round(bad)


class TestThePicture:
    def test_it_is_valid_xml(self, scene):
        import xml.etree.ElementTree as ET
        ET.fromstring(scene)

    def test_there_is_a_drawing_and_a_ring_for_every_item(self, scene, round_data):
        for item in round_data["items"]:
            assert f'id="vig-{item["n"]}"' in scene, item["answer"]
            assert f'id="ring-{item["n"]}"' in scene, item["answer"]

    def test_nothing_extra_is_drawn(self, scene, round_data):
        drawn = {int(n) for n in re.findall(r'id="vig-(\d+)"', scene)}
        assert drawn == {item["n"] for item in round_data["items"]}

    def test_the_vignettes_are_not_numbered(self, scene):
        # The mapping from drawing to blank is what "show me where" sells.
        assert "badge-no" not in scene

    def test_no_answer_is_written_on_it(self, scene, round_data):
        lowered = scene.lower()
        for item in round_data["items"]:
            assert f">{item['answer'].lower()}<" not in lowered, item["answer"]

    def test_every_ring_starts_switched_off(self, scene):
        assert 'class="ring on"' not in scene

    def test_it_scales_rather_than_being_a_fixed_size(self, scene):
        assert "viewBox" in scene


class TestThePageThatIsBuilt:
    def test_nothing_is_left_unfilled(self, page):
        for placeholder in ("__ROUND__", "__RULES__", "__LEADERBOARD__", "__SCENE__", "__BUILD__"):
            assert placeholder not in page, f"{placeholder} was never substituted"

    def test_the_picture_is_in_it(self, page):
        assert 'id=\\"vig-1\\"' in page or 'id="vig-1"' in page

    def test_every_item_is_in_it(self, page, round_data):
        for item in round_data["items"]:
            assert item["answer"] in page

    def test_it_is_one_file_with_nothing_to_fetch(self, page):
        assert "<script src=" not in page
        assert '<link rel="stylesheet"' not in page
        assert "<img " not in page

    def test_the_engine_is_loaded_before_the_game_that_reads_it(self, page):
        # app.js grabs the global on its first line; loaded the other way round the
        # page throws before it draws anything.
        assert page.index("var QuickFireEngine") < page.index("var E = QuickFireEngine")

    def test_a_script_tag_cannot_be_closed_early_by_the_data(self, build):
        embedded = build.embed([{"spot": "What about </script> then?"}])
        assert "</script>" not in embedded
        assert "<\\/script>" in embedded


class TestTheWorkersCopyOfTheRules:
    """The board recalculates every score. It can only be trusted while it agrees."""

    @staticmethod
    @pytest.fixture(scope="class")
    def generated() -> dict:
        return json.loads(GENERATED.read_text(encoding="utf-8"))

    @staticmethod
    @pytest.fixture(scope="class")
    def source() -> dict:
        return json.loads(RULES_FILE.read_text(encoding="utf-8"))

    def test_regenerating_changes_nothing(self):
        before = GENERATED.read_text(encoding="utf-8")
        subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "generate_worker_rules.py")],
            check=True, capture_output=True,
        )
        assert GENERATED.read_text(encoding="utf-8") == before, (
            "the worker's rules are stale - run scripts/generate_worker_rules.py"
        )

    def test_every_price_came_across(self, generated, source):
        assert generated["picture"]["clueCosts"] == source["picture"]["clueCosts"]

    def test_every_scoring_constant_came_across(self, generated, source):
        for key in ("pointsPerItem", "finisherBonus", "cleanSweepBonus"):
            assert generated["picture"][key] == source["picture"][key], key

    def test_the_worker_knows_how_big_the_round_is(self, generated, round_data):
        # Without this the board has nothing to measure "twenty found out of nineteen"
        # against, and an impossible score walks straight onto it.
        assert generated["rounds"] == {round_data["id"]: len(round_data["items"])}

    def test_no_clue_costs_more_than_an_item_is_worth(self, source):
        for key, cost in source["picture"]["clueCosts"].items():
            assert 0 <= cost < source["picture"]["pointsPerItem"], f"{key} is priced at {cost}"

    def test_reveal_is_free_because_it_already_costs_the_item(self, source):
        assert source["picture"]["clueCosts"]["reveal"] == 0

    def test_the_clue_ladder_rises(self, source):
        # A dearer clue that tells you less than a cheaper one is a trap for the player.
        order = ["category", "letter", "where", "spot", "hint", "anagram"]
        costs = [source["picture"]["clueCosts"][key] for key in order]
        assert costs == sorted(costs), dict(zip(order, costs))
