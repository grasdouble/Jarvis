"""Require a PR Changeset to cover at least one changed versionable workspace."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Iterable

import yaml


FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)


def changed_paths(base_sha: str, root: Path) -> tuple[list[PurePosixPath], list[PurePosixPath]]:
    """Return changed paths and changed Changeset markdown paths from the PR diff."""

    def diff_paths(*pathspecs: str) -> list[PurePosixPath]:
        result = subprocess.run(
            ["git", "diff", "--name-only", "-z", "--diff-filter=ACMRD", f"{base_sha}...HEAD", "--", *pathspecs],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        return [PurePosixPath(path) for path in result.stdout.split("\0") if path]

    return diff_paths(), diff_paths(".changeset/*.md")


def workspace_packages(root: Path) -> dict[PurePosixPath, str]:
    """Discover versionable packages using the repository workspace patterns."""
    workspace = yaml.safe_load((root / "pnpm-workspace.yaml").read_text(encoding="utf-8"))
    changeset_config = json.loads((root / ".changeset/config.json").read_text(encoding="utf-8"))
    private_versions = changeset_config.get("privatePackages", {}).get("version", False)
    ignored = set(changeset_config.get("ignore", []))
    packages: dict[PurePosixPath, str] = {}

    for pattern in workspace.get("packages", []):
        if pattern.startswith("!"):
            continue
        for manifest_path in root.glob(f"{pattern.rstrip('/')}/package.json"):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            name = manifest.get("name")
            if not isinstance(name, str) or name in ignored:
                continue
            if manifest.get("private", False) and not private_versions:
                continue
            packages[PurePosixPath(manifest_path.parent.relative_to(root).as_posix())] = name
    return packages


def changed_workspace_names(
    paths: Iterable[PurePosixPath], packages: dict[PurePosixPath, str]
) -> set[str]:
    names: set[str] = set()
    for path in paths:
        for package_root, name in packages.items():
            if path == package_root or package_root in path.parents:
                names.add(name)
    return names


def parse_changeset(text: str) -> set[str] | None:
    """Return release target names, an empty set for no-release, or None for docs."""
    match = FRONTMATTER.match(text)
    if not match:
        return None
    frontmatter = yaml.safe_load(match.group(1))
    if frontmatter is None:
        return set()
    if not isinstance(frontmatter, dict) or not all(isinstance(name, str) for name in frontmatter):
        raise ValueError("Changeset frontmatter must map package names to release types")
    return set(frontmatter)


def changeset_coverage_error(changed: set[str], entries: list[set[str]]) -> str | None:
    if not changed:
        return None
    if any(not targets for targets in entries):
        return None
    covered = set().union(*entries) if entries else set()
    if changed & covered:
        return None
    changed_list = ", ".join(sorted(changed))
    if covered:
        covered_list = ", ".join(sorted(covered))
        return (
            f"Changed versionable workspaces ({changed_list}) are not targeted by the PR's Changesets "
            f"({covered_list}). Add a Changeset for an impacted package, or an explicit empty Changeset "
            "if the package changes have no release impact."
        )
    return (
        f"Changed versionable workspaces ({changed_list}) need a Changeset targeting an impacted package, "
        "or an explicit empty Changeset if the changes have no release impact."
    )


def validate(base_sha: str, root: Path) -> str:
    paths, changeset_paths = changed_paths(base_sha, root)
    changed = changed_workspace_names(paths, workspace_packages(root))
    entries = []
    for path in changeset_paths:
        parsed = parse_changeset((root / path).read_text(encoding="utf-8"))
        if parsed is not None:
            entries.append(parsed)
    error = changeset_coverage_error(changed, entries)
    if error:
        raise ValueError(error)
    if changed:
        print(f"Changeset coverage passed for changed workspaces: {', '.join(sorted(changed))}.")
    else:
        print("No versionable workspace packages changed; no Changeset target is required.")
    return "passed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_sha", help="Exact base commit SHA from the pull_request event")
    args = parser.parse_args()
    try:
        validate(args.base_sha, Path.cwd())
    except (OSError, subprocess.CalledProcessError, ValueError, yaml.YAMLError) as error:
        print(f"Changeset package coverage failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
