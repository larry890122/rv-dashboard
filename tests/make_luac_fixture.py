#!/usr/bin/env python3
"""Create small LUAC workbooks for strict extractor tests."""

from __future__ import annotations

import argparse
import html
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.extract_luac import HEADERS


def serial(value: str) -> int:
    return (date.fromisoformat(value) - date(1899, 12, 30)).days


def address(column: int, row: int) -> str:
    letters = ""
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row}"


def cell(column: int, row: int, value: object, formula: str | None = None) -> str:
    ref = address(column, row)
    if isinstance(value, str):
        return f'<c r="{ref}" t="inlineStr"><is><t>{html.escape(value)}</t></is></c>'
    formula_xml = f"<f>{html.escape(formula)}</f>" if formula else ""
    return f'<c r="{ref}">{formula_xml}<v>{value}</v></c>'


def formula_without_cache(column: int, row: int, formula: str) -> str:
    return f'<c r="{address(column, row)}"><f>{html.escape(formula)}</f></c>'


def make_fixture(path: Path, variant: str = "valid", data_date: str = "2026-09-16", count: int = 40) -> Path:
    headers = list(HEADERS)
    if variant == "level3":
        headers[-1] = "CLASSIFICATION_NAME(BICS,3,TYPE=ISSUER)"
    rows = ["<row r=\"1\">" + "".join(cell(index, 1, value) for index, value in enumerate(headers, 1)) + "</row>"]
    for index in range(count):
        row = index + 2
        identifier = f"US000000{index:04d}"
        if variant == "duplicate" and index == count - 1:
            identifier = "US0000000000"
        values = {
            1: identifier,
            2: f"TEST {index} 5.0 09/15/30",
            3: f"Test Issuer {index % 5}",
            4: f"T{index % 4}",
            5: serial("2030-09-15"),
            6: ("A-", "BBB+", "AA", "BB+")[index % 4],
            7: 4 + (index % 4500) / 100,
            11: "Technology",
        }
        rows.append(f'<row r="{row}">' + "".join(cell(column, row, value) for column, value in values.items()) + "</row>")
    for index in range(count):
        row = count + index + 2
        identifier = f"US000000{index:04d}"
        if variant == "mismatch" and index == count - 1:
            identifier = "US9999999999"
        market_date = "2026-09-15" if variant == "mixed-date" and index == count - 1 else data_date
        bond_yield: object = 55 if variant == "outlier" and index == count - 1 else 5 + (index % 400) / 100
        oas: object = "" if variant == "missing" and index == count - 1 else "NaN" if variant == "nonfinite" and index == count - 1 else 120 + (index % 400)
        values = {1: identifier, 8: serial(market_date), 9: oas, 10: bond_yield}
        contents = []
        for column, value in values.items():
            if value == "":
                continue
            formula = "100+20" if variant == "formula" and index == 0 and column == 9 else "BQL(\"cached query\")" if variant == "bql" and index == 0 and column == 9 else None
            if variant == "bql-no-cache" and index == 0 and column == 9:
                contents.append(formula_without_cache(column, row, "BQL(\"cached query\")"))
            else:
                contents.append(cell(column, row, value, formula))
        rows.append(f'<row r="{row}">' + "".join(contents) + "</row>")

    sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' \
        + "".join(rows) + '</sheetData></worksheet>'
    workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' \
        '<sheets><sheet name="LUAC" sheetId="1" r:id="rId1"/></sheets></workbook>'
    workbook_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' \
        '</Relationships>'
    package_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' \
        '</Relationships>'
    content_types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' \
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' \
        '<Default Extension="xml" ContentType="application/xml"/>' \
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' \
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' \
        '</Types>'
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", package_rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--variant", default="valid")
    parser.add_argument("--date", default="2026-09-16")
    parser.add_argument("--count", type=int, default=40)
    args = parser.parse_args()
    make_fixture(args.out, args.variant, args.date, args.count)


if __name__ == "__main__":
    main()
