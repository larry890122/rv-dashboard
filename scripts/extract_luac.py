#!/usr/bin/env python3
"""Extract a sanitized LUAC snapshot from a value workbook or one cached BQL formula."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from luac_data import COLUMNS, quality_flags, validate_luac

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
HEADERS = (
    "ID",
    "SECURITY_DES",
    "LONG_COMP_NAME",
    "TICKER",
    "MATURITY",
    "BB_COMPOSITE",
    "MTY_YEARS_TDY",
    "DATES",
    "SPREAD(ST='OAS',PRICING_SOURCE=BVAL,SIDE=BID)",
    "YIELD(YT=CONVENTION,PRICING_SOURCE=BVAL,SIDE=BID)",
    "CLASSIFICATION_NAME(BICS,1,TYPE=ISSUER)",
)
CELL = re.compile(r"^([A-Z]+)(\d+)$")


def column_number(address: str) -> int:
    match = CELL.match(address)
    if not match:
        raise ValueError(f"Invalid Excel address: {address}")
    result = 0
    for character in match.group(1):
        result = result * 26 + ord(character) - 64
    return result


def excel_date(serial: object, date_1904: bool) -> str:
    if not isinstance(serial, (int, float)) or isinstance(serial, bool) or not math.isfinite(serial):
        raise ValueError("Invalid Excel date")
    epoch = date(1904, 1, 1) if date_1904 else date(1899, 12, 30)
    return (epoch + timedelta(days=math.floor(serial))).isoformat()


def workbook_sheet(archive: zipfile.ZipFile) -> tuple[str, bool]:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    nodes = workbook.findall(f".//{{{MAIN}}}sheet")
    if len(nodes) != 1:
        raise ValueError("LUAC workbook must contain exactly one worksheet")
    relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        node.get("Id"): node.get("Target")
        for node in relations.findall(f"{{{PACKAGE_REL}}}Relationship")
    }
    target = targets[nodes[0].get(f"{{{REL}}}id")].lstrip("/")
    path = target if target.startswith("xl/") else f"xl/{target}"
    properties = workbook.find(f"{{{MAIN}}}workbookPr")
    date_1904 = properties is not None and properties.get("date1904") in ("1", "true")
    return path.replace("/./", "/"), date_1904


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(node.itertext()) for node in root.findall(f"{{{MAIN}}}si")]


def cells(archive: zipfile.ZipFile, path: str, strings: list[str]) -> tuple[dict[tuple[int, int], object], int, str]:
    root = ET.fromstring(archive.read(path))
    formulas = root.findall(f".//{{{MAIN}}}f")
    source_mode = "values"
    if formulas:
        if len(formulas) != 1 or not re.match(r"^\s*(?:_xll\.)?BQL\s*\(", formulas[0].text or "", re.IGNORECASE):
            raise ValueError("LUAC workbook may contain only one cached BQL formula")
        formula_cell = next((cell for cell in root.findall(f".//{{{MAIN}}}c") if formulas[0] in list(cell)), None)
        cached = formula_cell.find(f"{{{MAIN}}}v") if formula_cell is not None else None
        if cached is None or cached.text in (None, ""):
            raise ValueError("LUAC BQL formula has no saved cached value")
        source_mode = "bql_cache"
    result: dict[tuple[int, int], object] = {}
    maximum_row = 0
    for cell in root.findall(f".//{{{MAIN}}}c"):
        address = cell.get("r", "")
        match = CELL.match(address)
        if not match:
            continue
        row, column = int(match.group(2)), column_number(address)
        maximum_row = max(maximum_row, row)
        cell_type = cell.get("t", "n")
        if cell_type == "inlineStr":
            value: object = "".join(node.text or "" for node in cell.findall(f".//{{{MAIN}}}t"))
        else:
            value_node = cell.find(f"{{{MAIN}}}v")
            if value_node is None or value_node.text in (None, "") or cell_type == "e":
                value = None
            elif cell_type == "s":
                value = strings[int(value_node.text)]
            elif cell_type == "str":
                value = value_node.text
            else:
                try:
                    value = float(value_node.text)
                except ValueError as error:
                    raise ValueError(f"Invalid numeric cell {address}") from error
        result[(row, column)] = value
    return result, maximum_row, source_mode


def require_text(value: object, field: str, row: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"LUAC row {row} has invalid {field}")
    return value.strip()


def require_number(value: object, field: str, row: int) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"LUAC row {row} has invalid {field}")
    return value


def extract(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        sheet_path, date_1904 = workbook_sheet(archive)
        values, maximum_row, source_mode = cells(archive, sheet_path, shared_strings(archive))

    actual_headers = tuple(values.get((1, column)) for column in range(1, 12))
    if actual_headers != HEADERS:
        raise ValueError("LUAC workbook headers do not match the required schema")

    static: dict[str, tuple[object, ...]] = {}
    market: dict[str, tuple[object, ...]] = {}
    order: list[str] = []
    for row in range(2, maximum_row + 1):
        record = tuple(values.get((row, column)) for column in range(1, 12))
        if all(value in (None, "") for value in record):
            continue
        identifier = require_text(record[0], "ID", row)
        has_static = any(record[index] not in (None, "") for index in (1, 2, 3, 4, 5, 6, 10))
        has_market = any(record[index] not in (None, "") for index in (7, 8, 9))
        if has_static == has_market:
            raise ValueError(f"LUAC row {row} must belong to exactly one data block")
        target = static if has_static else market
        if identifier in target:
            raise ValueError(f"Duplicate LUAC ID: {identifier}")
        if has_static:
            for index, field in zip((1, 2, 3, 5, 10), ("SECURITY_DES", "issuer", "ticker", "rating", "industry")):
                require_text(record[index], field, row)
            require_number(record[4], "maturity", row)
            require_number(record[6], "maturity_years", row)
            order.append(identifier)
        else:
            for index, field in zip((7, 8, 9), ("date", "oas_bp", "yield_pct")):
                require_number(record[index], field, row)
        target[identifier] = record

    if set(static) != set(market) or not static:
        raise ValueError("LUAC static and market ID sets must match exactly")
    data_dates = {excel_date(market[identifier][7], date_1904) for identifier in market}
    if len(data_dates) != 1:
        raise ValueError("LUAC market rows must use one data date")

    records: list[list[object]] = []
    for identifier in order:
        source, prices = static[identifier], market[identifier]
        years = require_number(source[6], "maturity_years", 0)
        oas = require_number(prices[8], "oas_bp", 0)
        bond_yield = require_number(prices[9], "yield_pct", 0)
        records.append([
            identifier,
            require_text(source[1], "SECURITY_DES", 0),
            require_text(source[2], "issuer", 0),
            require_text(source[3], "ticker", 0),
            excel_date(source[4], date_1904),
            require_text(source[5], "rating", 0),
            years,
            oas,
            bond_yield,
            require_text(source[10], "industry", 0),
            quality_flags(years, oas, bond_yield),
        ])
    result = {"schema_version": 1, "date": data_dates.pop(), "columns": list(COLUMNS), "records": records}
    validate_luac(result)
    extract.source_mode = source_mode
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, help="Write sanitized JSON here; defaults to stdout")
    parser.add_argument("--audit", type=Path, help="Write private validation summary outside the repository")
    arguments = parser.parse_args()
    data = extract(arguments.workbook)
    count, anomalies = validate_luac(data)
    serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    if arguments.output:
        arguments.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")
    if arguments.audit:
        audit_path = arguments.audit.resolve()
        if audit_path.is_relative_to(ROOT):
            parser.error("Private audit must be outside the repository")
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        audit_path.write_text(
            json.dumps({"date": data["date"], "records": count, "anomalies": anomalies, "source_mode": getattr(extract, "source_mode", "values")}, indent=2) + "\n",
            encoding="utf-8",
        )
    print(f"LUAC snapshot date={data['date']} records={count} anomalies={anomalies} source={getattr(extract, 'source_mode', 'values')}", file=sys.stderr)


if __name__ == "__main__":
    main()
