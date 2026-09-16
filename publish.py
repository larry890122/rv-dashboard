#!/usr/bin/env python3
"""Build the sanitized standalone RV dashboard."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from rv_data import validate
from luac_data import validate_luac


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "site.config.json"
PUBLIC = ROOT / "public"
FORBIDDEN_PUBLIC_TERMS = (
    ".xlsm",
    ".pptx",
    ".pdf",
    "/users/",
    "data-audit",
    "slide_locator",
    "source_file",
)


def git_sha() -> str:
    github_sha = os.environ.get("GITHUB_SHA", "").strip()
    if github_sha:
        return github_sha
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True
    )
    return result.stdout.strip() if result.returncode == 0 else "UNCOMMITTED"


def content_hash(output: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(output.rglob("*")):
        if path.is_file() and path.name != "integration-manifest.json":
            digest.update(path.relative_to(output).as_posix().encode("utf-8"))
            digest.update(path.read_bytes())
    return digest.hexdigest()


def asset_version(*paths: Path) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def validate_public(output: Path) -> None:
    required = (
        output / "index.html",
        output / "assets" / "site.css",
        output / "assets" / "rv.css",
        output / "assets" / "rv.js",
        output / "assets" / "update.css",
        output / "assets" / "update.js",
        output / "assets" / "upload-config.json",
        output / "assets" / "rv-data.json",
        output / "assets" / "luac-bonds.json",
        output / "assets" / "luac-model.js",
        output / "assets" / "bonds.js",
        output / "assets" / "bonds.css",
        output / "update.html",
        output / "bonds.html",
        output / "integration-manifest.json",
    )
    for path in required:
        if not path.is_file():
            raise ValueError(f"Missing public output: {path.relative_to(output)}")
    for path in output.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".html", ".json", ".js", ".css", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8").lower()
        for term in FORBIDDEN_PUBLIC_TERMS:
            if term in text:
                raise ValueError(f"Forbidden public term {term!r}: {path.relative_to(output)}")


def build() -> tuple[Path, dict]:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    snapshot = json.loads((ROOT / "assets" / "rv-data.json").read_text(encoding="utf-8"))
    validate(snapshot)
    luac = json.loads((ROOT / "assets" / "luac-bonds.json").read_text(encoding="utf-8"))
    validate_luac(luac)
    template = (ROOT / "index.template.html").read_text(encoding="utf-8")
    page = template.replace("{{DATA_DATE_ISO}}", snapshot["date"]).replace(
        "{{DATA_DATE_DISPLAY}}", snapshot["date"].replace("-", "/")
    )
    update_version = asset_version(ROOT / "assets" / "update.js", ROOT / "assets" / "update.css", ROOT / "assets" / "luac-model.js")
    update_page = (ROOT / "update.template.html").read_text(encoding="utf-8").replace("{{UPDATE_VERSION}}", update_version)
    bonds_template = (ROOT / "bonds.template.html").read_text(encoding="utf-8")
    luac_version = f"{luac['date']}-{asset_version(ROOT / 'assets' / 'luac-bonds.json', ROOT / 'assets' / 'bonds.js', ROOT / 'assets' / 'luac-model.js')}"
    bonds_page = bonds_template.replace("{{LUAC_DATE_ISO}}", luac["date"]).replace("{{LUAC_DATE_DISPLAY}}", luac["date"].replace("-", "/")).replace("{{LUAC_VERSION}}", luac_version)
    temporary = Path(tempfile.mkdtemp(prefix=".rv-public-", dir=ROOT))
    backup: Path | None = None
    try:
        assets = temporary / "assets"
        assets.mkdir()
        for name in ("site.css", "rv.css", "rv.js", "bonds.css", "bonds.js", "luac-model.js", "update.css", "update.js", "upload-config.json", "rv-data.json", "luac-bonds.json"):
            shutil.copy2(ROOT / "assets" / name, assets / name)
        (temporary / "index.html").write_text(page, encoding="utf-8")
        (temporary / "update.html").write_text(update_page, encoding="utf-8")
        (temporary / "bonds.html").write_text(bonds_page, encoding="utf-8")
        (temporary / ".nojekyll").write_text("", encoding="utf-8")
        manifest = {
            "schema_version": 1,
            "site_id": config["site_id"],
            "production_url": config["production_url"],
            "commit_sha": git_sha(),
            "built_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "content_as_of": snapshot["date"],
            "datasets": {
                "rv": {"content_as_of": snapshot["date"], "asset": "assets/rv-data.json"},
                "luac": {"content_as_of": luac["date"], "asset": "assets/luac-bonds.json"},
            },
            "validation_status": "PASS",
            "content_sha256": content_hash(temporary),
            "peer": config["peer"],
        }
        (temporary / "integration-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        validate_public(temporary)
        if PUBLIC.exists():
            backup = ROOT / ".public-previous"
            if backup.exists():
                shutil.rmtree(backup)
            PUBLIC.rename(backup)
        temporary.rename(PUBLIC)
        if backup and backup.exists():
            shutil.rmtree(backup)
        return PUBLIC, manifest
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if backup and backup.exists() and not PUBLIC.exists():
            backup.rename(PUBLIC)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-only", action="store_true", required=True)
    parser.parse_args()
    output, manifest = build()
    print(
        f"RV site built: {output} date={manifest['content_as_of']} "
        f"validation={manifest['validation_status']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
