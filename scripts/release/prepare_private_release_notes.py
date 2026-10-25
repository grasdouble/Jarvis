"""Create runner-local fallback changelogs for private package releases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]


def prepare_release_notes(root: Path = ROOT) -> list[Path]:
    """Add fallback notes for private workspaces that do not have a changelog."""
    created: list[Path] = []
    for package_root in (root / "apps", root / "packages"):
        if not package_root.is_dir():
            continue
        for manifest_path in package_root.glob("*/package.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid workspace manifest: {manifest_path}") from error
            if manifest.get("private") is not True:
                continue
            name = manifest.get("name")
            version = manifest.get("version")
            if not isinstance(name, str) or not isinstance(version, str):
                raise ValueError(f"Private workspace manifest lacks name or version: {manifest_path}")
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
                raise ValueError(f"Private workspace {name!r} has an invalid release version.")
            changelog = manifest_path.parent / "CHANGELOG.md"
            if changelog.is_symlink():
                raise ValueError(f"Refusing to write through a changelog symlink: {changelog}")
            if changelog.exists():
                if not changelog.is_file():
                    raise ValueError(f"Changelog path is not a regular file: {changelog}")
                continue
            changelog.write_text(
                f"## {version}\n\nNo release notes were recorded for this private package version.\n",
                encoding="utf-8",
            )
            created.append(changelog)
    return created


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        created = prepare_release_notes(args.root.resolve())
    except (OSError, ValueError) as error:
        print(f"Private release-note preparation failed: {error}", file=sys.stderr)
        return 1
    print(f"Prepared fallback changelogs for {len(created)} private package(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
