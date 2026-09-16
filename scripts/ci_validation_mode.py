#!/usr/bin/env python3
"""Choose fast data validation only for trusted, data-only workflow events."""

from __future__ import annotations

import argparse
import sys

DATA_PATH = "assets/rv-data.json"
LUAC_DATA_PATH = "assets/luac-bonds.json"


def validation_mode(
    event: str,
    paths: list[str],
    *,
    actor: str = "",
    expected_actor: str = "",
    head_ref: str = "",
    has_label: bool = False,
    has_luac_label: bool = False,
    head_repo: str = "",
    repository: str = "",
) -> str:
    changed = [path.strip() for path in paths if path.strip()]
    if changed == [DATA_PATH]:
        mode = "data"
        trusted_branch = head_ref.startswith("automation/rv-data-")
        trusted_label = has_label
    elif changed == [LUAC_DATA_PATH]:
        mode = "luac-data"
        trusted_branch = head_ref.startswith("automation/luac-data-")
        trusted_label = has_luac_label
    else:
        return "full"
    if event in {"push", "workflow_dispatch"}:
        return mode
    if event != "pull_request":
        return "full"
    trusted = (
        bool(expected_actor)
        and actor == expected_actor
        and trusted_branch
        and trusted_label
        and head_repo == repository
    )
    return mode if trusted else "full"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", required=True)
    parser.add_argument("--actor", default="")
    parser.add_argument("--expected-actor", default="")
    parser.add_argument("--head-ref", default="")
    parser.add_argument("--has-label", action="store_true")
    parser.add_argument("--has-luac-label", action="store_true")
    parser.add_argument("--head-repo", default="")
    parser.add_argument("--repository", default="")
    arguments = parser.parse_args()
    print(validation_mode(
        arguments.event,
        sys.stdin.read().splitlines(),
        actor=arguments.actor,
        expected_actor=arguments.expected_actor,
        head_ref=arguments.head_ref,
        has_label=arguments.has_label,
        has_luac_label=arguments.has_luac_label,
        head_repo=arguments.head_repo,
        repository=arguments.repository,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
