#!/usr/bin/env python3
"""Validate one automated RV snapshot and its built public output."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from rv_data import FIELDS, valid, validate


def load_json(path: Path) -> dict:
    def reject_constant(value: str):
        raise ValueError(f"Invalid JSON number: {value}")

    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)


def validate_excel_snapshot(data: dict) -> int:
    validate(data)
    count = 0
    for section in data["sections"].values():
        for records in section.values():
            for record in records:
                for field in FIELDS:
                    if not valid(record[field], field):
                        raise ValueError(f"Missing or invalid {field}: {record['sector']}")
                    if record["sources"][field] != "Excel":
                        raise ValueError(f"Automated snapshot source must be Excel: {record['sector']}/{field}")
                    count += 1
    if count != 460:
        raise ValueError(f"Expected 460 values; got {count}")
    return count


def validate_fast_update(current: dict, previous: dict, public_root: Path) -> None:
    count = validate_excel_snapshot(current)
    validate(previous)
    if current["date"] <= previous["date"]:
        raise ValueError(
            f"Data date {current['date']} must be later than {previous['date']}"
        )

    public_data = load_json(public_root / "assets" / "rv-data.json")
    if public_data != current:
        raise ValueError("Built public snapshot does not match assets/rv-data.json")

    manifest = load_json(public_root / "integration-manifest.json")
    if manifest.get("content_as_of") != current["date"] or manifest.get("validation_status") != "PASS":
        raise ValueError("Built manifest date or validation status is incorrect")

    page = (public_root / "index.html").read_text(encoding="utf-8")
    if current["date"].replace("-", "/") not in page:
        raise ValueError("Built page does not show the snapshot date")
    if f"assets/rv.js?v={current['date']}" not in page:
        raise ValueError("Built page does not version data assets with the snapshot date")
    print(f"Fast RV data validation PASS: date={current['date']} values={count}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--public-root", type=Path, required=True)
    arguments = parser.parse_args()
    validate_fast_update(
        load_json(arguments.current),
        load_json(arguments.previous),
        arguments.public_root,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
