"""Validation rules for the sanitized LUAC bond snapshot."""

from __future__ import annotations

import math
from datetime import date


COLUMNS = (
    "id",
    "security_des",
    "issuer",
    "ticker",
    "maturity",
    "rating",
    "maturity_years",
    "oas_bp",
    "yield_pct",
    "industry",
    "flags",
)
FLAG_VALUES = ("yield_outlier", "maturity_outlier", "oas_outlier")
MAX_RECORDS = 20_000
MAX_PUBLISH_BYTES = 4 * 1024 * 1024


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def quality_flags(maturity_years: float, oas_bp: float, yield_pct: float) -> list[str]:
    flags: list[str] = []
    if yield_pct <= 0 or yield_pct > 50:
        flags.append("yield_outlier")
    if maturity_years <= 0 or maturity_years > 100:
        flags.append("maturity_outlier")
    if oas_bp < -250 or oas_bp > 5000:
        flags.append("oas_outlier")
    return flags


def rating_band(rating: str) -> str:
    if rating == "AAA":
        return "AAA"
    for prefix in ("AA", "BBB", "BB", "A"):
        if rating.startswith(prefix):
            return prefix
    return "NR"


def validate_luac(data: dict) -> tuple[int, int]:
    if not isinstance(data, dict) or set(data) != {"schema_version", "date", "columns", "records"}:
        raise ValueError("Unexpected LUAC snapshot fields")
    if data["schema_version"] != 1 or data["columns"] != list(COLUMNS):
        raise ValueError("Unexpected LUAC schema")
    date.fromisoformat(data["date"])
    records = data["records"]
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_RECORDS:
        raise ValueError("LUAC record count is out of range")

    identifiers: set[str] = set()
    anomaly_count = 0
    for index, record in enumerate(records, start=1):
        if not isinstance(record, list) or len(record) != len(COLUMNS):
            raise ValueError(f"LUAC row {index} has the wrong shape")
        identifier, security, issuer, ticker, maturity, rating, years, oas, bond_yield, industry, flags = record
        for position, value in enumerate((identifier, security, issuer, ticker, maturity, rating, industry)):
            limit = (64, 180, 300, 32, 10, 16, 160)[position]
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise ValueError(f"LUAC row {index} has invalid text")
        if identifier in identifiers:
            raise ValueError(f"Duplicate LUAC ID: {identifier}")
        identifiers.add(identifier)
        date.fromisoformat(maturity)
        if not all(finite(value) for value in (years, oas, bond_yield)):
            raise ValueError(f"LUAC row {index} has invalid numeric data")
        expected_flags = quality_flags(years, oas, bond_yield)
        if flags != expected_flags or any(flag not in FLAG_VALUES for flag in flags):
            raise ValueError(f"LUAC row {index} has invalid quality flags")
        anomaly_count += bool(flags)
    return len(records), anomaly_count


def validate_count_drift(new_count: int, current_count: int) -> None:
    if current_count <= 0:
        raise ValueError("Current LUAC snapshot is empty")
    low, high = current_count * 0.8, current_count * 1.2
    if not low <= new_count <= high:
        raise ValueError(
            f"LUAC record count changed from {current_count} to {new_count}; manual review is required"
        )
