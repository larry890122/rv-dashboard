#!/usr/bin/env python3
"""Validate a trusted LUAC data-only update without running the full site suite."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from luac_data import MAX_PUBLISH_BYTES, validate_count_drift, validate_luac


def load_json(path: Path) -> dict:
    def reject_constant(value: str):
        raise ValueError(f"Invalid JSON number: {value}")

    return json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)


def validate_fast_luac(current: dict, previous: dict, current_path: Path, public_root: Path) -> None:
    count, anomalies = validate_luac(current)
    previous_count, _ = validate_luac(previous)
    if current["date"] <= previous["date"]:
        raise ValueError(f"Data date {current['date']} must be later than {previous['date']}")
    validate_count_drift(count, previous_count)
    if current_path.stat().st_size > MAX_PUBLISH_BYTES:
        raise ValueError("LUAC snapshot exceeds the 4 MiB publish limit")

    chartable = sum(
        not record[10] and 0 < record[6] <= 50
        for record in current["records"]
    )
    if chartable == 0:
        raise ValueError("LUAC snapshot has no chartable 0Y-50Y records")

    public_data = load_json(public_root / "assets" / "luac-bonds.json")
    if public_data != current:
        raise ValueError("Built public LUAC snapshot does not match assets/luac-bonds.json")

    manifest = load_json(public_root / "integration-manifest.json")
    dataset = manifest.get("datasets", {}).get("luac", {})
    if dataset != {"content_as_of": current["date"], "asset": "assets/luac-bonds.json"}:
        raise ValueError("Built manifest LUAC dataset is incorrect")

    page = (public_root / "bonds.html").read_text(encoding="utf-8")
    if current["date"].replace("-", "/") not in page:
        raise ValueError("Built bonds page does not show the LUAC snapshot date")
    if f'datetime="{current["date"]}"' not in page:
        raise ValueError("Built bonds page has the wrong machine-readable date")
    print(
        f"Fast LUAC validation PASS: date={current['date']} records={count} "
        f"chartable={chartable} anomalies={anomalies}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--public-root", type=Path, required=True)
    arguments = parser.parse_args()
    validate_fast_luac(
        load_json(arguments.current),
        load_json(arguments.previous),
        arguments.current,
        arguments.public_root,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
