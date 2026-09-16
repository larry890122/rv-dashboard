from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from luac_data import COLUMNS, quality_flags, validate_count_drift, validate_luac
from scripts.extract_luac import extract
from scripts.verify_luac_data_only_pr import verify as verify_luac_data_only_pr
from tests.make_luac_fixture import make_fixture

ROOT = Path(__file__).resolve().parents[1]


class LuacTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = json.loads((ROOT / "assets" / "luac-bonds.json").read_text(encoding="utf-8"))

    def test_initial_public_snapshot_contract(self):
        count, anomalies = validate_luac(self.snapshot)
        self.assertEqual(count, len(self.snapshot["records"]))
        self.assertEqual(anomalies, sum(bool(record[-1]) for record in self.snapshot["records"]))
        self.assertEqual(self.snapshot["columns"], list(COLUMNS))
        self.assertEqual({record[9] for record in self.snapshot["records"]}, {"Communications", "Consumer Discretionary", "Consumer Staples", "Energy", "Financials", "Health Care", "Industrials", "Materials", "Real Estate", "Technology", "Utilities"})
        self.assertLess((ROOT / "assets" / "luac-bonds.json").stat().st_size, 4 * 1024 * 1024)
        serialized = json.dumps(self.snapshot).lower()
        for forbidden in (".xlsx", "/users/", "sha256", "source_file"):
            self.assertNotIn(forbidden, serialized)

    def test_built_asset_and_page_contract(self):
        public = json.loads((ROOT / "public" / "assets" / "luac-bonds.json").read_text(encoding="utf-8"))
        self.assertEqual(public, self.snapshot)
        page = (ROOT / "public" / "bonds.html").read_text(encoding="utf-8")
        self.assertIn("單券相對價值比較表", page)
        self.assertIn("Maturity × Yield", page)
        self.assertIn("Yield、OAS Spread", page)
        self.assertIn('name="bond-metric" value="yield_pct" checked', page)
        self.assertRegex(page, rf'assets/bonds\.js\?v={self.snapshot["date"]}-[0-9a-f]{{10}}')

    def test_strict_two_block_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = make_fixture(Path(directory) / "valid.xlsx")
            result = extract(workbook)
            self.assertEqual(validate_luac(result), (40, 0))
            self.assertEqual(result["records"][0][0], "US0000000000")
            self.assertEqual(result["records"][0][4], "2030-09-15")

    def test_single_cached_bql_formula_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            result = extract(make_fixture(Path(directory) / "bql.xlsx", "bql"))
            self.assertEqual(validate_luac(result), (40, 0))
            self.assertEqual(getattr(extract, "source_mode"), "bql_cache")

    def test_large_synthetic_update_fixture_is_publishable(self):
        with tempfile.TemporaryDirectory() as directory:
            result = extract(make_fixture(Path(directory) / "large.xlsx", count=8870))
            self.assertEqual(validate_luac(result), (8870, 0))
            self.assertLess(len(json.dumps(result).encode("utf-8")), 4 * 1024 * 1024)

    def test_formula_missing_duplicate_mismatch_and_mixed_date_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for variant, message in (
                ("formula", "only one cached BQL formula"),
                ("bql-no-cache", "no saved cached value"),
                ("level3", "headers do not match"),
                ("missing", "invalid oas_bp"),
                ("nonfinite", "invalid oas_bp"),
                ("duplicate", "Duplicate LUAC ID"),
                ("mismatch", "ID sets must match"),
                ("mixed-date", "one data date"),
            ):
                with self.subTest(variant=variant):
                    workbook = make_fixture(Path(directory) / f"{variant}.xlsx", variant)
                    with self.assertRaisesRegex(ValueError, message):
                        extract(workbook)

    def test_outliers_are_retained_and_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            result = extract(make_fixture(Path(directory) / "outlier.xlsx", "outlier"))
            self.assertEqual(validate_luac(result), (40, 1))
            self.assertEqual(result["records"][-1][8], 55)
            self.assertEqual(result["records"][-1][-1], ["yield_outlier"])
        self.assertEqual(quality_flags(0, -251, 0), ["yield_outlier", "maturity_outlier", "oas_outlier"])

    def test_count_drift_requires_manual_review(self):
        validate_count_drift(80, 100)
        validate_count_drift(120, 100)
        for value in (79, 121):
            with self.assertRaisesRegex(ValueError, "manual review"):
                validate_count_drift(value, 100)

    def test_automated_luac_pr_allows_only_its_asset(self):
        verify_luac_data_only_pr(["assets/luac-bonds.json"])
        for changed in (["assets/luac-bonds.json", "assets/bonds.js"], ["assets/rv-data.json"], []):
            with self.assertRaises(ValueError):
                verify_luac_data_only_pr(changed)

    def test_luac_automation_has_dedicated_gate(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.label.name == 'automated-luac-data'", workflow)
        self.assertIn("startsWith(github.event.pull_request.head.ref, 'automation/luac-data-')", workflow)
        self.assertIn("scripts/verify_luac_data_only_pr.py", workflow)


if __name__ == "__main__":
    unittest.main()
