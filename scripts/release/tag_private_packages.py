"""Run Changesets git-tag and provide ephemeral notes for every emitted event."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]


def prepare_release_notes(output_file: Path, root: Path = ROOT) -> list[Path]:
    """Ensure action's release handler won't skip events lacking a changelog file."""
    try:
        events = [
            json.loads(line)
            for line in output_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("Changesets did not produce readable tag events.") from error

    packages: dict[str, Path] = {}
    for package_root in (root / "apps", root / "packages"):
        if not package_root.is_dir():
            continue
        for manifest_path in package_root.glob("*/package.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ValueError(f"Invalid workspace manifest: {manifest_path}") from error
            name = manifest.get("name")
            if isinstance(name, str):
                packages[name] = manifest_path.parent

    created: list[Path] = []
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "git-tag":
            continue
        name = event.get("packageName")
        tag = event.get("tag")
        package_dir = packages.get(name) if isinstance(name, str) else None
        if package_dir is None or not isinstance(tag, str) or not tag.startswith(f"{name}@"):
            raise ValueError("Changesets emitted a tag for an unknown or invalid workspace package.")
        version = json.loads(
            (package_dir / "package.json").read_text(encoding="utf-8")
        ).get("version")
        if not isinstance(version, str) or tag != f"{name}@{version}" or not re.fullmatch(
            r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version
        ):
            raise ValueError(f"Changesets emitted an unexpected version tag for {name!r}.")
        changelog = package_dir / "CHANGELOG.md"
        if not changelog.exists():
            changelog.write_text(
                f"## {version}\n\nNo release notes were recorded for this private package version.\n",
                encoding="utf-8",
            )
            created.append(changelog)
    return created


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, help="Pinned @changesets/cli executable")
    parser.add_argument("--cwd", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.cwd.resolve()
    output = os.environ.get("CHANGESETS_OUTPUT")
    if not output:
        print(
            "CHANGESETS_OUTPUT was not provided by the pinned Changesets action.",
            file=sys.stderr,
        )
        return 1
    cli = Path(args.cli)
    if not cli.is_absolute():
        cli = root / cli
    if not cli.is_file():
        print("The pinned Changesets CLI executable is unavailable.", file=sys.stderr)
        return 1

    environment = os.environ.copy()
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"):
        environment.pop(name, None)
    try:
        subprocess.run([str(cli), "tag"], cwd=root, env=environment, check=True)
        created = prepare_release_notes(Path(output), root)
        print(f"Prepared fallback changelogs for {len(created)} package(s).")
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"Private package tagging failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
