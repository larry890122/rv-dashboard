#!/usr/bin/env python3
"""Extract one sanitized RV snapshot from four complete Excel workbooks."""

from __future__ import annotations

import argparse
import json
import math
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from rv_data import FIELDS, METRICS, SECTIONS, validate

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
ALIASES = {"Ins": "Insurance", "Chem": "Chemical", "HC": "Healthcare", "Trans": "Transportation"}


def col(number: int) -> str:
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def values(archive: zipfile.ZipFile, path: str, strings: list[str]) -> dict[str, object]:
    result: dict[str, object] = {}
    for cell in ET.fromstring(archive.read(path)).findall(f".//{{{MAIN}}}c"):
        address = cell.get("r")
        cell_type = cell.get("t", "n")
        if cell_type == "inlineStr":
            result[address] = "".join(node.text or "" for node in cell.findall(f".//{{{MAIN}}}t"))
            continue
        value = cell.find(f"{{{MAIN}}}v")
        if value is None or value.text in (None, "") or cell_type == "e":
            result[address] = None
            continue
        if cell_type == "s":
            result[address] = strings[int(value.text)]
            continue
        try:
            number = float(value.text)
            result[address] = number if math.isfinite(number) else None
        except ValueError:
            result[address] = None
    return result


def sheets(archive: zipfile.ZipFile) -> tuple[dict[str, str], bool]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {node.get("Id"): node.get("Target") for node in relations.findall(f"{{{PACKAGE_REL}}}Relationship")}
    result = {}
    for node in workbook.findall(f".//{{{MAIN}}}sheet"):
        target = targets[node.get(f"{{{REL}}}id")].lstrip("/")
        result[node.get("name")] = target if target.startswith("xl/") else f"xl/{target}"
    properties = workbook.find(f"{{{MAIN}}}workbookPr")
    date_1904 = properties is not None and properties.get("date1904") in ("1", "true")
    return result, date_1904


def workbook(path: Path, metric: str) -> tuple[dict[str, list[dict]], list[str]]:
    output: dict[str, list[dict]] = {}
    dates: list[str] = []
    with zipfile.ZipFile(path) as archive:
        try:
            shared = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            strings = ["".join(node.itertext()) for node in shared.findall(f"{{{MAIN}}}si")]
        except KeyError:
            strings = []
        paths, date_1904 = sheets(archive)
        for section_index, (section, categories) in enumerate(SECTIONS.items()):
            if section not in paths or f"{section} data" not in paths:
                raise ValueError(f"{metric} missing {section} sheets")
            summary = values(archive, paths[section], strings)
            history = values(archive, paths[f"{section} data"], strings)
            records = []
            for index, category in enumerate(categories):
                actual = summary.get(f"{col(5 + index)}4")
                if ALIASES.get(actual, actual) != category:
                    raise ValueError(f"{metric}/{section}: expected {category}, got {actual}")
                serial = history.get(f"{col(1 + index * 4)}8")
                if not isinstance(serial, (int, float)) or not math.isfinite(serial):
                    raise ValueError(f"{metric}/{section}/{category}: invalid date")
                epoch = date(1904, 1, 1) if date_1904 else date(1899, 12, 30)
                dates.append((epoch + timedelta(days=math.floor(serial))).isoformat())
                record = {"sector": category, "sources": {}}
                for field, row in zip(FIELDS, (5, 7, 9, 11, 6)):
                    column = ((16, 18, 17)[section_index] if field == "pct" else 5) + index
                    value = summary.get(f"{col(column)}{row}")
                    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                        raise ValueError(f"{metric}/{section}/{category}: invalid {field}")
                    if field == "pct" and not 0 <= value <= 1:
                        raise ValueError(f"{metric}/{section}/{category}: percentile out of range")
                    record[field] = value
                    record["sources"][field] = "Excel"
                if not record["min"] <= record["median"] <= record["max"]:
                    raise ValueError(f"{metric}/{section}/{category}: Min <= Median <= Max failed")
                records.append(record)
            output[section] = records
    return output, dates


def extract(files: list[Path]) -> dict:
    if len(files) != 4:
        raise ValueError("Exactly four Excel workbooks are required")
    parsed = [workbook(path, metric) for metric, path in zip(METRICS, files)]
    dates = [item for _, workbook_dates in parsed for item in workbook_dates]
    if len(dates) != 92 or len(set(dates)) != 1:
        raise ValueError("All 92 embedded dates must be present and identical")
    result = {"date": dates[0], "horizon": "2Y", "sections": {section: {} for section in SECTIONS}}
    for metric, (sections, _) in zip(METRICS, parsed):
        for section in SECTIONS:
            result["sections"][section][metric] = sections[section]
    validate(result)
    if any(row[field] is None or row["sources"][field] != "Excel"
           for section in result["sections"].values() for records in section.values()
           for row in records for field in FIELDS):
        raise ValueError("Strict Excel snapshot is incomplete")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workbooks", nargs=4, required=True, type=Path, metavar="PATH")
    parser.add_argument("--output", type=Path, help="Write sanitized JSON here; defaults to stdout")
    arguments = parser.parse_args()
    serialized = json.dumps(extract(arguments.workbooks), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if arguments.output:
        arguments.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")


if __name__ == "__main__":
    main()
