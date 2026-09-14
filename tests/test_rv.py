from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from peer_status import validate_peer
from rv_data import FIELDS, choose, validate
from scripts.extract_rv import NS, cell_number, slide_values
from scripts.extract_excel_strict import extract as extract_excel_strict
from scripts.verify_data_only_pr import verify as verify_data_only_pr
from tests.make_xlsx_fixtures import make_fixtures


class RVTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "assets" / "rv-data.json").read_text(encoding="utf-8"))
        cls.public = ROOT / "public"

    def test_all_460_values(self):
        validate(self.data)
        values = [
            row[field]
            for section in self.data["sections"].values()
            for records in section.values()
            for row in records
            for field in FIELDS
        ]
        self.assertEqual(len(values), 460)
        self.assertTrue(all(value is not None for value in values))
        self.assertRegex(self.data["date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_public_snapshot_identical(self):
        public_data = json.loads((self.public / "assets" / "rv-data.json").read_text(encoding="utf-8"))
        self.assertEqual(self.data, public_data)

    def test_page_and_bidirectional_navigation(self):
        page = (self.public / "index.html").read_text(encoding="utf-8")
        self.assertIn(self.data["date"].replace("-", "/"), page)
        self.assertIn("非即時行情", page)
        self.assertIn("https://larry890122.github.io/ib-knowledge-base/", page)
        self.assertEqual(page.count('name="metric"'), 4)
        self.assertEqual(page.count('name="section"'), 3)
        self.assertIn('href="update.html"', page)
        update_page = (self.public / "update.html").read_text(encoding="utf-8")
        self.assertIn("四份 Excel", update_page)
        self.assertIn('assets/update.js', update_page)

    def test_integration_manifest(self):
        manifest = json.loads((self.public / "integration-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["site_id"], "rv-dashboard")
        self.assertEqual(manifest["production_url"], "https://larry890122.github.io/rv-dashboard/")
        self.assertEqual(manifest["content_as_of"], self.data["date"])
        self.assertEqual(manifest["validation_status"], "PASS")
        validate_peer({**manifest, "site_id": "ib-knowledge-base"}, "ib-knowledge-base")

    def test_data_assets_are_versioned_by_snapshot_date(self):
        page = (self.public / "index.html").read_text(encoding="utf-8")
        script = (self.public / "assets" / "rv.js").read_text(encoding="utf-8")
        self.assertIn(f'assets/rv.js?v={self.data["date"]}', page)
        self.assertIn('rv-data.json?v=', script)
        self.assertIn("{cache:'no-store'}", script)

    def test_no_provenance_leak(self):
        for path in self.public.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in {".html", ".json", ".js", ".css", ".txt"}:
                continue
            serialized = path.read_text(encoding="utf-8").lower()
            for term in (".xlsm", ".pptx", ".pdf", "/users/", "data-audit", "slide_locator"):
                self.assertNotIn(term, serialized, path.relative_to(self.public))
        leaked_files = [path for path in self.public.rglob("*") if path.suffix.lower() in {".xlsx", ".xlsm", ".pptx", ".pdf"}]
        self.assertEqual(leaked_files, [])

    def test_missing_errors_and_no_cache(self):
        ns = NS["m"]
        for content in (
            "<c/>",
            "<c><f>A1+B1</f></c>",
            '<c t="e"><v>#REF!</v></c>',
            '<c t="s"><v>0</v></c>',
            "<c><v>NaN</v></c>",
            "<c><v>Infinity</v></c>",
        ):
            cell = ET.fromstring(content.replace("<c", f'<c xmlns="{ns}"', 1))
            self.assertIsNone(cell_number(cell), content)
        cell = ET.fromstring(f'<c xmlns="{ns}"><f>A1</f><v>0</v></c>')
        self.assertEqual(cell_number(cell), 0)

    def test_fallback_and_dates(self):
        date = "2026-08-05"
        for bad in (None, "#REF!", float("nan"), float("inf"), True):
            self.assertEqual(choose(bad, 91, "current", date, date, date), (91, "投影片"))
            self.assertEqual(choose(bad, 91, "current", date, date, "2026-08-04"), (None, "缺值"))
        self.assertEqual(choose(0, 91, "current", date, date, date), (0, "Excel"))
        self.assertEqual(choose(None, None, "median", date, date, date), (None, "缺值"))

    def test_invalid_snapshot_rejected(self):
        for field, value in (("min", 1000), ("median", -10), ("max", 0), ("pct", 1.1), ("current", float("nan"))):
            data = copy.deepcopy(self.data)
            data["sections"]["Overview"]["Spread"][0][field] = value
            with self.assertRaises(ValueError):
                validate(data)

    def test_slide_fallback_excludes_stale_combo_chart(self):
        class FakeDeck:
            def read(self, path):
                if "slide2.xml" in path:
                    return f'<p:sld xmlns:p="{NS["p"]}" xmlns:a="{NS["a"]}"><p:sp><p:nvSpPr><p:cNvPr name="value-current-0"/></p:nvSpPr><a:t>91</a:t></p:sp></p:sld>'
                if path != "ppt/slides/charts/chart2.xml":
                    raise AssertionError(path)
                return f'<c:chart xmlns:c="{NS["c"]}"><c:ser><c:val><c:numCache><c:pt idx="0"><c:v>0.409</c:v></c:pt></c:numCache></c:val></c:ser></c:chart>'

        values = slide_values(FakeDeck(), 2, 1)[0]
        self.assertEqual(values["current"][0], 91)
        self.assertEqual(values["pct"][0], 0.409)
        self.assertNotIn("median", values)

    def test_strict_excel_extraction_and_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = make_fixtures(Path(directory) / "valid")
            result = extract_excel_strict(paths)
            self.assertEqual(result["date"], "2026-08-06")
            self.assertTrue(all(
                row["sources"][field] == "Excel"
                for section in result["sections"].values()
                for records in section.values()
                for row in records
                for field in FIELDS
            ))
            for variant, message in (("date-mismatch", "92 embedded dates"), ("missing", "invalid current"), ("order", "Min <= Median <= Max")):
                bad = make_fixtures(Path(directory) / variant, variant)
                with self.assertRaisesRegex(ValueError, message):
                    extract_excel_strict(bad)

    def test_automated_pr_allows_only_the_data_file(self):
        verify_data_only_pr(["assets/rv-data.json"])
        for changed in (
            ["assets/rv-data.json", "assets/rv.js"],
            ["assets/rv.js"],
            [],
        ):
            with self.assertRaises(ValueError):
                verify_data_only_pr(changed)

    def test_automated_pr_triggers_one_main_deployment(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("github.event.action == 'labeled'", workflow)
        self.assertIn("github.event.label.name == 'automated-rv-data'", workflow)
        self.assertIn("actions: write", workflow)
        self.assertIn("gh workflow run pages.yml --ref main", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)


if __name__ == "__main__":
    unittest.main()
