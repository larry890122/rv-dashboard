#!/usr/bin/env python3
"""Local-only HTTP bridge for the LUAC Bloomberg Desktop API diagnostic."""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from luac_data import validate_luac
from probe_bloomberg_luac import (
    FIELDS,
    classify,
    compare,
    reference_request,
    resolve_bics_level1_field,
    snapshot,
    universe_members,
)

MAX_BODY = 4 * 1024 * 1024
ALLOWED_ORIGINS = {
    "https://larry890122.github.io",
    "http://127.0.0.1:8766",
    "http://localhost:8766",
}


def open_session():
    import blpapi

    options = blpapi.SessionOptions()
    options.setServerHost("localhost")
    options.setServerPort(8194)
    session = blpapi.Session(options)
    if not session.start() or not session.openService("//blp/refdata"):
        session.stop()
        raise ConnectionError("Bloomberg Desktop API session failed to start")
    return blpapi, session


def health() -> dict[str, object]:
    session = None
    try:
        _, session = open_session()
        return {"ready": True}
    finally:
        if session is not None:
            session.stop()


def run_probe(baseline: dict) -> dict[str, object]:
    validate_luac(baseline)
    diagnostic: dict[str, object] = {
        "connected": False,
        "reference_ok": False,
        "universe_ok": False,
        "count": 0,
        "required_field_coverage_pct": 0,
        "ids_match": False,
        "industry_match": False,
        "static_mismatch_count": 0,
        "industry_mismatch_count": 0,
        "max_oas_diff_bp": None,
        "max_yield_diff_pct": None,
        "passed": False,
        "error_class": None,
    }
    session = None
    try:
        blpapi, session = open_session()
        diagnostic["connected"] = True
        resolve_bics_level1_field(blpapi, session)
        known_ids = [row[0] for row in baseline["records"][:5]]
        for identifier in known_ids:
            values = reference_request(blpapi, session, [identifier], list(FIELDS.values())).get(identifier, {})
            if all(field in values for field in FIELDS.values()):
                diagnostic["reference_ok"] = True
                break
        raw_members = universe_members(blpapi, session, "LUACTRUU Index", "INDX_MEMBERS")
        diagnostic["universe_ok"] = bool(raw_members) and len(raw_members) == len(set(raw_members))
        members = list(dict.fromkeys(raw_members))
        diagnostic["count"] = len(members)
        records: dict[str, dict[str, object]] = {}
        for offset in range(0, len(members), 250):
            records.update(reference_request(blpapi, session, members[offset:offset + 250], list(FIELDS.values())))
        total = len(members) * len(FIELDS)
        present = sum(field in values for values in records.values() for field in FIELDS.values())
        coverage = round(100 * present / total, 4) if total else 0
        diagnostic["required_field_coverage_pct"] = coverage
        if not diagnostic["reference_ok"]:
            raise ValueError("single-security required field coverage is incomplete")
        if not diagnostic["universe_ok"]:
            raise ValueError("Bloomberg universe is empty or contains duplicate members")
        if coverage != 100 or len(records) != len(members):
            raise ValueError("required field coverage is incomplete")
        comparison = compare(snapshot(records, baseline["date"]), baseline)
        diagnostic.update(comparison)
        diagnostic["passed"] = bool(comparison["eligible_for_api_planning"])
        if not diagnostic["passed"]:
            diagnostic["error_class"] = "comparison_failed"
    except Exception as error:
        diagnostic["error_class"] = diagnostic["error_class"] or classify(error)
    finally:
        if session is not None:
            session.stop()
    return diagnostic


class Handler(BaseHTTPRequestHandler):
    server_version = "LUACBloombergBridge/1"

    def log_message(self, format_string, *args):
        return

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        return origin if origin in ALLOWED_ORIGINS else None

    def _headers(self, status: int, origin: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _json(self, status: int, value: dict[str, object]) -> None:
        self._headers(status, self._origin())
        self.wfile.write(json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8"))

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {self.server.token}"

    def do_OPTIONS(self) -> None:
        origin = self._origin()
        if not origin:
            self._json(403, {"error": "origin_not_allowed"})
            return
        self._headers(204, origin)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            self._json(200, health())
        except Exception as error:
            self._json(503, {"error": classify(error), "ready": False})

    def do_POST(self) -> None:
        if self.path != "/probe":
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_BODY:
                raise ValueError("payload_too_large")
            payload = json.loads(self.rfile.read(length))
            if set(payload) != {"data"}:
                raise ValueError("invalid_payload")
            self._json(200, run_probe(payload["data"]))
        except ValueError as error:
            self._json(413 if str(error) == "payload_too_large" else 400, {"error": str(error)})
        except Exception as error:
            self._json(500, {"error": classify(error)})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, default=8768)
    args = parser.parse_args()
    if len(args.token) < 32:
        parser.error("token must contain at least 32 characters")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.token = args.token
    print(f"Bloomberg bridge listening on http://127.0.0.1:{args.port}. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
