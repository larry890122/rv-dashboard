from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.ci_validation_mode import validation_mode
from scripts.validate_fast_data import validate_excel_snapshot, validate_fast_update
from scripts.validate_fast_luac import validate_fast_luac


class FastDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "assets" / "rv-data.json").read_text(encoding="utf-8"))

    def changed(self, mutator):
        data = copy.deepcopy(self.data)
        mutator(data)
        return data

    def test_trusted_data_pr_and_main_data_commit_use_fast_mode(self):
        trusted = {
            "actor": "rv-uploader[bot]",
            "expected_actor": "rv-uploader[bot]",
            "head_ref": "automation/rv-data-2026-09-16-abc",
            "has_label": True,
            "head_repo": "owner/rv-dashboard",
            "repository": "owner/rv-dashboard",
        }
        self.assertEqual(validation_mode("pull_request", ["assets/rv-data.json"], **trusted), "data")
        self.assertEqual(validation_mode("push", ["assets/rv-data.json"]), "data")
        self.assertEqual(validation_mode("workflow_dispatch", ["assets/rv-data.json"]), "data")

    def test_trusted_luac_pr_and_main_data_commit_use_fast_mode(self):
        trusted = {
            "actor": "rv-uploader[bot]",
            "expected_actor": "rv-uploader[bot]",
            "head_ref": "automation/luac-data-2026-09-16-abc",
            "has_luac_label": True,
            "head_repo": "owner/rv-dashboard",
            "repository": "owner/rv-dashboard",
        }
        path = ["assets/luac-bonds.json"]
        self.assertEqual(validation_mode("pull_request", path, **trusted), "luac-data")
        self.assertEqual(validation_mode("push", path), "luac-data")
        for override in ({"actor": "person"}, {"has_luac_label": False}, {"head_ref": "codex/manual"}):
            self.assertEqual(validation_mode("pull_request", path, **{**trusted, **override}), "full")

    def test_untrusted_or_multi_file_pr_uses_full_mode(self):
        trusted = {
            "actor": "rv-uploader[bot]",
            "expected_actor": "rv-uploader[bot]",
            "head_ref": "automation/rv-data-2026-09-16-abc",
            "has_label": True,
            "head_repo": "owner/rv-dashboard",
            "repository": "owner/rv-dashboard",
        }
        for changes, override in (
            (["assets/rv-data.json", "assets/rv.js"], {}),
            (["assets/rv-data.json"], {"actor": "person"}),
            (["assets/rv-data.json"], {"head_ref": "codex/manual"}),
            (["assets/rv-data.json"], {"has_label": False}),
            (["assets/rv-data.json"], {"head_repo": "fork/rv-dashboard"}),
        ):
            self.assertEqual(validation_mode("pull_request", changes, **{**trusted, **override}), "full")

    def test_complete_excel_snapshot_is_accepted(self):
        self.assertEqual(validate_excel_snapshot(self.data), 460)

    def test_fast_validation_rejects_data_that_can_break_charts(self):
        mutations = (
            lambda data: data["sections"]["Overview"]["Spread"][0].pop("current"),
            lambda data: data["sections"]["Overview"]["Spread"][0].update(current=None),
            lambda data: data["sections"]["Overview"]["Spread"][0].update(current=float("nan")),
            lambda data: data["sections"]["Overview"]["Spread"].pop(),
            lambda data: data["sections"]["Overview"]["Spread"][0].update(pct=1.1),
            lambda data: data["sections"]["Overview"]["Spread"][0].update(min=999, median=10, max=20),
            lambda data: data["sections"]["Overview"]["Spread"].reverse(),
            lambda data: data["sections"]["Overview"]["Spread"][0]["sources"].update(current="投影片"),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), self.assertRaises((KeyError, TypeError, ValueError)):
                validate_excel_snapshot(self.changed(mutate))

    def test_fast_update_requires_newer_date_and_matching_build(self):
        previous = copy.deepcopy(self.data)
        previous["date"] = "2026-09-14"
        validate_fast_update(self.data, previous, ROOT / "public")
        previous["date"] = self.data["date"]
        with self.assertRaisesRegex(ValueError, "must be later"):
            validate_fast_update(self.data, previous, ROOT / "public")

    def test_fast_luac_validation_focuses_on_snapshot_and_chart_safety(self):
        current = json.loads((ROOT / "assets" / "luac-bonds.json").read_text(encoding="utf-8"))
        previous = copy.deepcopy(current)
        previous["date"] = "2026-09-14"
        validate_fast_luac(current, previous, ROOT / "assets" / "luac-bonds.json", ROOT / "public")
        broken = copy.deepcopy(current)
        broken["records"][0][8] = None
        with self.assertRaisesRegex(ValueError, "invalid numeric"):
            validate_fast_luac(broken, previous, ROOT / "assets" / "luac-bonds.json", ROOT / "public")


if __name__ == "__main__":
    unittest.main()
