#!/usr/bin/env python3
"""Fail unless a PR changes exactly the one permitted public data source file."""

from __future__ import annotations

import sys

ALLOWED = ["assets/rv-data.json"]


def verify(paths: list[str]) -> None:
    changed = [path.strip() for path in paths if path.strip()]
    if changed != ALLOWED:
        raise ValueError(f"Automated RV PR must change exactly {ALLOWED[0]}; got {changed}")


def main() -> int:
    try:
        verify(sys.stdin.read().splitlines())
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
