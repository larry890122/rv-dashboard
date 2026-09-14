#!/usr/bin/env python3
"""Create synthetic XLSX workbooks in a caller-provided temporary directory."""

from __future__ import annotations

import argparse
import html
import zipfile
from datetime import date, timedelta
from pathlib import Path

SECTIONS = {
    "Overview": ["JULI", "Fin", "Non-Fin", "AA", "A", "BBB"],
    "Cyclical": ["US Bank", "Yankee Bank", "Ins", "M&M", "Chem", "Tech", "Auto", "Media", "Energy", "Capital Good"],
    "Non-Cyclical": ["Telecom", "Utility", "F&B", "Tobacco", "HC", "Retail", "Trans"],
}
METRICS = ["Spread", "10Y", "30Y", "10s30s"]
FILENAMES = {
    "Spread": "2Y Percentile RV.xlsx",
    "10Y": "10Y RV.xlsx",
    "30Y": "30Y RV.xlsx",
    "10s30s": "10s30s RV.xlsx",
}


def col(number: int) -> str:
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def numeric_cell(address: str, value: float) -> str:
    return f'<c r="{address}"><v>{value}</v></c>'


def text_cell(address: str, value: str) -> str:
    return f'<c r="{address}" t="inlineStr"><is><t>{html.escape(value)}</t></is></c>'


def worksheet(cells: list[str]) -> str:
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row>' \
        + "".join(cells) + "</row></sheetData></worksheet>"


def excel_serial(value: str) -> int:
    return (date.fromisoformat(value) - date(1899, 12, 30)).days


def create_workbook(path: Path, metric: str, data_date: str, variant: str = "valid") -> None:
    sheet_names: list[str] = []
    sheet_xml: list[str] = []
    metric_offset = METRICS.index(metric) * 100
    for section_index, (section, categories) in enumerate(SECTIONS.items()):
        history_cells = []
        summary_cells = []
        for index, category in enumerate(categories):
            date_value = data_date
            if variant == "date-mismatch" and metric == "30Y" and section == "Overview" and index == 0:
                date_value = (date.fromisoformat(data_date) + timedelta(days=1)).isoformat()
            history_cells.append(numeric_cell(f"{col(1 + index * 4)}8", excel_serial(date_value)))
            summary_cells.append(text_cell(f"{col(5 + index)}4", category))
            base = metric_offset + section_index * 20 + index
            values = {"min": 10 + base, "median": 20 + base, "max": 30 + base, "current": 25 + base, "pct": 0.5}
            if variant == "order" and metric == "Spread" and section == "Overview" and index == 0:
                values["min"] = values["max"] + 1
            for field, row in zip(("min", "median", "max", "current", "pct"), (5, 7, 9, 11, 6)):
                if variant == "missing" and metric == "Spread" and section == "Overview" and index == 0 and field == "current":
                    continue
                column = ([16, 18, 17][section_index] if field == "pct" else 5) + index
                summary_cells.append(numeric_cell(f"{col(column)}{row}", values[field]))
        sheet_names.extend((f"{section} data", section))
        sheet_xml.extend((worksheet(history_cells), worksheet(summary_cells)))

    sheets = "".join(
        f'<sheet name="{html.escape(name)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, name in enumerate(sheet_names, 1)
    )
    rels = "".join(
        f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(sheet_names) + 1)
    )
    workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' \
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' \
        f"{sheets}</sheets></workbook>"
    workbook_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' \
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' \
        f"{rels}</Relationships>"
    content_types = '<?xml version="1.0" encoding="UTF-8"?>' \
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' \
        '<Default Extension="xml" ContentType="application/xml"/></Types>'

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        for index, content in enumerate(sheet_xml, 1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", content)


def make_fixtures(output: Path, variant: str = "valid", data_date: str = "2026-08-06") -> list[Path]:
    output.mkdir(parents=True, exist_ok=True)
    paths = []
    for metric in METRICS:
        path = output / FILENAMES[metric]
        create_workbook(path, metric, data_date, variant)
        paths.append(path)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--variant", choices=("valid", "date-mismatch", "outdated", "missing", "order"), default="valid")
    parser.add_argument("--date", default="2026-08-06")
    arguments = parser.parse_args()
    for result in make_fixtures(arguments.out, arguments.variant, arguments.date):
        print(result.name)


if __name__ == "__main__":
    main()
