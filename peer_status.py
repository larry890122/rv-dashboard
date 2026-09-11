#!/usr/bin/env python3
"""Read and validate the peer site's published integration manifest."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REQUIRED = {
    "schema_version",
    "site_id",
    "production_url",
    "commit_sha",
    "built_at",
    "content_as_of",
    "validation_status",
    "peer",
}


def validate_peer(data: dict, expected_site_id: str) -> None:
    missing = REQUIRED - data.keys()
    if missing:
        raise ValueError(f"missing fields: {', '.join(sorted(missing))}")
    if data["schema_version"] != 1:
        raise ValueError(f"unsupported schema_version={data['schema_version']!r}")
    if data["site_id"] != expected_site_id:
        raise ValueError(f"unexpected site_id={data['site_id']!r}")
    if data["validation_status"] != "PASS":
        raise ValueError(f"peer validation_status={data['validation_status']!r}")


def fetch_manifest(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return json.load(response)
    except urllib.error.URLError as urllib_exc:
        try:
            result = subprocess.run(
                ["/usr/bin/curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "15", url],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(result.stdout)
        except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError):
            raise urllib_exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-reachable", action="store_true")
    args = parser.parse_args()
    config = json.loads((ROOT / "site.config.json").read_text(encoding="utf-8"))
    peer = config["peer"]
    try:
        data = fetch_manifest(peer["manifest_url"])
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        print(f"PEER WARNING: {peer['site_id']} is unreachable: {exc}", file=sys.stderr)
        return 1 if args.require_reachable else 0
    try:
        validate_peer(data, peer["site_id"])
    except (TypeError, ValueError) as exc:
        print(f"PEER INVALID: {exc}", file=sys.stderr)
        return 1
    print(f"Peer site: {data['site_id']}")
    print(f"Production: {data['production_url']}")
    print(f"Commit: {data['commit_sha']}")
    print(f"Content as of: {data['content_as_of']}")
    print(f"Built at: {data['built_at']}")
    print(f"Validation: {data['validation_status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
