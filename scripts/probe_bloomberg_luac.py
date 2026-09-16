#!/usr/bin/env python3
"""Read-only Bloomberg Desktop API feasibility probe for the LUAC bond universe.

Run this only in Windows Terminal on a company computer with Bloomberg Terminal
already signed in. Standard output contains aggregate diagnostics, never raw rows.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from luac_data import COLUMNS, quality_flags, validate_luac

FIELDS = {
    "security_des": "SECURITY_DES",
    "issuer": "LONG_COMP_NAME",
    "ticker": "TICKER",
    "maturity": "MATURITY",
    "rating": "BB_COMPOSITE",
    "maturity_years": "MTY_YEARS_TDY",
    "oas_bp": "OAS_SPREAD_BID",
    "yield_pct": "YLD_YTM_BID",
    "industry": "BICS_LEVEL_1_SECTOR_NAME",
}


def classify(error: BaseException) -> str:
    name = type(error).__name__.lower()
    message = str(error).lower()
    if "import" in name or "module" in message:
        return "dependency_unavailable"
    if "start" in message or "connect" in message or "session" in message:
        return "terminal_connection"
    if "authorization" in message or "permission" in message:
        return "not_authorized"
    if "field" in message:
        return "field_error"
    return "api_error"


def scalar(element):
    value = element.getValue()
    if isinstance(value, (datetime, date)):
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("non-finite Bloomberg value")
        return value
    return str(value).strip()


def reference_request(blpapi, session, securities: list[str], fields: list[str]) -> dict[str, dict[str, object]]:
    service = session.getService("//blp/refdata")
    request = service.createRequest("ReferenceDataRequest")
    for security in securities:
        request.append("securities", security)
    for field in fields:
        request.append("fields", field)
    session.sendRequest(request)
    result: dict[str, dict[str, object]] = {}
    while True:
        event = session.nextEvent(30_000)
        if event.eventType() == blpapi.Event.TIMEOUT:
            raise TimeoutError("Bloomberg request timed out")
        for message in event:
            if message.hasElement("responseError"):
                raise RuntimeError("Bloomberg response error")
            if not message.hasElement("securityData"):
                continue
            security_data = message.getElement("securityData")
            for index in range(security_data.numValues()):
                item = security_data.getValueAsElement(index)
                identifier = item.getElementAsString("security")
                if item.hasElement("securityError"):
                    result[identifier] = {"_error": "security_error"}
                    continue
                values: dict[str, object] = {}
                field_data = item.getElement("fieldData")
                for field in fields:
                    if field_data.hasElement(field):
                        values[field] = scalar(field_data.getElement(field))
                if item.hasElement("fieldExceptions") and item.getElement("fieldExceptions").numValues():
                    values["_field_error"] = True
                result[identifier] = values
        if event.eventType() == blpapi.Event.RESPONSE:
            return result


def universe_members(blpapi, session, universe: str, field: str) -> list[str]:
    # Bulk fields need direct element traversal, which is intentionally isolated here.
    service = session.getService("//blp/refdata")
    request = service.createRequest("ReferenceDataRequest")
    request.append("securities", universe)
    request.append("fields", field)
    session.sendRequest(request)
    members: list[str] = []
    while True:
        event = session.nextEvent(30_000)
        if event.eventType() == blpapi.Event.TIMEOUT:
            raise TimeoutError("Bloomberg universe request timed out")
        for message in event:
            if not message.hasElement("securityData"):
                continue
            items = message.getElement("securityData")
            for item_index in range(items.numValues()):
                data = items.getValueAsElement(item_index).getElement("fieldData")
                if not data.hasElement(field):
                    continue
                bulk = data.getElement(field)
                for row_index in range(bulk.numValues()):
                    row = bulk.getValueAsElement(row_index)
                    for column_index in range(row.numElements()):
                        column = row.getElement(column_index)
                        name = str(column.name()).lower()
                        if "member" in name and ("ticker" in name or "security" in name):
                            value = str(column.getValue()).strip()
                            if value:
                                members.append(value)
                            break
        if event.eventType() == blpapi.Event.RESPONSE:
            break
    return members


def resolve_bics_level1_field(blpapi, session) -> str:
    """Verify the exact BICS Level 1 field through Bloomberg field metadata."""
    if not session.openService("//blp/apiflds"):
        raise ConnectionError("Bloomberg field metadata service failed to open")
    service = session.getService("//blp/apiflds")
    request = service.createRequest("FieldSearchRequest")
    request.set("searchSpec", "BICS Level 1 Sector Name")
    request.set("returnFieldDocumentation", False)
    session.sendRequest(request)
    matches: set[str] = set()
    while True:
        event = session.nextEvent(30_000)
        if event.eventType() == blpapi.Event.TIMEOUT:
            raise TimeoutError("Bloomberg field metadata request timed out")
        for message in event:
            if message.hasElement("responseError"):
                raise RuntimeError("Bloomberg field metadata response error")
            if not message.hasElement("fieldData"):
                continue
            data = message.getElement("fieldData")
            for index in range(data.numValues()):
                item = data.getValueAsElement(index)
                info = item.getElement("fieldInfo") if item.hasElement("fieldInfo") else item
                for name in ("id", "mnemonic"):
                    if info.hasElement(name):
                        value = info.getElementAsString(name).strip()
                        if value == FIELDS["industry"]:
                            matches.add(value)
        if event.eventType() == blpapi.Event.RESPONSE:
            break
    if matches != {FIELDS["industry"]}:
        raise ValueError("BICS Level 1 field metadata did not resolve uniquely")
    return matches.pop()


def snapshot(records: dict[str, dict[str, object]], as_of: str) -> dict:
    rows = []
    for identifier, values in records.items():
        required = [values.get(field) for field in FIELDS.values()]
        if any(value in (None, "") for value in required):
            continue
        years = float(values[FIELDS["maturity_years"]])
        oas = float(values[FIELDS["oas_bp"]])
        bond_yield = float(values[FIELDS["yield_pct"]])
        rows.append([
            identifier,
            str(values[FIELDS["security_des"]]),
            str(values[FIELDS["issuer"]]),
            str(values[FIELDS["ticker"]]),
            str(values[FIELDS["maturity"]])[:10],
            str(values[FIELDS["rating"]]),
            years,
            oas,
            bond_yield,
            str(values[FIELDS["industry"]]),
            quality_flags(years, oas, bond_yield),
        ])
    result = {"schema_version": 1, "date": as_of, "columns": list(COLUMNS), "records": rows}
    validate_luac(result)
    return result


def compare(candidate: dict, baseline: dict) -> dict[str, object]:
    validate_luac(candidate)
    validate_luac(baseline)
    new = {row[0]: row for row in candidate["records"]}
    old = {row[0]: row for row in baseline["records"]}
    ids_match = set(new) == set(old)
    common = set(new) & set(old)
    max_oas = max((abs(new[key][7] - old[key][7]) for key in common), default=None)
    max_yield = max((abs(new[key][8] - old[key][8]) for key in common), default=None)
    static_indexes=(1,2,3,4,5)
    static_mismatches=sum(any(new[key][index]!=old[key][index] for index in static_indexes) for key in common)
    industry_mismatches=sum(new[key][9]!=old[key][9] for key in common)
    return {
        "ids_match": ids_match,
        "industry_match": ids_match and industry_mismatches == 0,
        "static_mismatch_count": static_mismatches,
        "industry_mismatch_count": industry_mismatches,
        "max_oas_diff_bp": max_oas,
        "max_yield_diff_pct": max_yield,
        "oas_within_0_5_bp": max_oas is not None and max_oas <= 0.5,
        "yield_within_0_01_pct_point": max_yield is not None and max_yield <= 0.01,
        "eligible_for_api_planning": ids_match and industry_mismatches == 0 and max_oas is not None and max_oas <= 0.5 and max_yield is not None and max_yield <= 0.01,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--known-security", required=True, help="One Bloomberg security identifier already present in the approved workbook")
    parser.add_argument("--universe", default="LUACTRUU Index")
    parser.add_argument("--universe-field", default="INDX_MEMBERS")
    parser.add_argument("--as-of", default=date.today().isoformat())
    parser.add_argument("--snapshot-output", type=Path, help="Optional sanitized contract output; must be outside this repository")
    parser.add_argument("--compare", type=Path, help="Optional sanitized Excel JSON from the same session")
    args = parser.parse_args()
    diagnostic: dict[str, object] = {"connected": False, "reference_ok": False, "universe_ok": False, "count": 0, "required_field_coverage_pct": 0, "error_class": None}
    session = None
    try:
        import blpapi

        options = blpapi.SessionOptions()
        options.setServerHost("localhost")
        options.setServerPort(8194)
        session = blpapi.Session(options)
        if not session.start() or not session.openService("//blp/refdata"):
            raise ConnectionError("Bloomberg Desktop API session failed to start")
        diagnostic["connected"] = True
        resolve_bics_level1_field(blpapi, session)
        one = reference_request(blpapi, session, [args.known_security], list(FIELDS.values()))
        one_values = one.get(args.known_security, {})
        diagnostic["reference_ok"] = all(field in one_values for field in FIELDS.values())
        raw_members = universe_members(blpapi, session, args.universe, args.universe_field)
        diagnostic["universe_ok"] = bool(raw_members) and len(raw_members) == len(set(raw_members))
        members = list(dict.fromkeys(raw_members))
        diagnostic["count"] = len(members)
        records: dict[str, dict[str, object]] = {}
        for offset in range(0, len(members), 250):
            records.update(reference_request(blpapi, session, members[offset:offset + 250], list(FIELDS.values())))
        total = len(members) * len(FIELDS)
        present = sum(field in values for values in records.values() for field in FIELDS.values())
        diagnostic["required_field_coverage_pct"] = round(100 * present / total, 4) if total else 0
        if args.snapshot_output:
            if diagnostic["required_field_coverage_pct"] != 100 or len(records) != len(members):
                raise ValueError("required field coverage is incomplete")
            output = args.snapshot_output.resolve()
            if output.is_relative_to(ROOT):
                parser.error("Bloomberg snapshot output must be outside the repository")
            candidate = snapshot(records, args.as_of)
            output.write_text(json.dumps(candidate, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            if args.compare:
                diagnostic["comparison"] = compare(candidate, json.loads(args.compare.read_text(encoding="utf-8")))
    except Exception as error:
        diagnostic["error_class"] = classify(error)
    finally:
        if session is not None:
            session.stop()
    print(json.dumps(diagnostic, separators=(",", ":")))
    return 0 if not diagnostic["error_class"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
