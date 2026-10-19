"""Run Changesets' PR gate, allowing only generated Changesets version PRs through."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

import yaml

from check_changeset_package_scope import (
    _git,
    _package_data,
    changed_paths,
    parse_changeset,
    validate,
    workspace_packages,
)


DEPENDENCY_FIELDS = {
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
}


def _version_only_manifest_change(before: dict, after: dict) -> bool:
    allowed = DEPENDENCY_FIELDS | {"version"}
    if any(before.get(key) != after.get(key) for key in before.keys() | after.keys() if key not in allowed):
        return False
    if not isinstance(after.get("version"), str):
        return False
    for field in DEPENDENCY_FIELDS:
        old_dependencies = before.get(field, {})
        new_dependencies = after.get(field, {})
        if not isinstance(old_dependencies, dict) or not isinstance(new_dependencies, dict):
            return False
        if old_dependencies.keys() != new_dependencies.keys():
            return False
        for name, old_value in old_dependencies.items():
            new_value = new_dependencies[name]
            if old_value != new_value and not (
                isinstance(old_value, str)
                and isinstance(new_value, str)
                and old_value.startswith("workspace:")
                and new_value.startswith("workspace:")
            ):
                return False
    return True


def is_changesets_version_pr(base_sha: str, root: Path) -> bool:
    """Recognize a generated version-only PR by its consumed entries and output shape."""
    changes = changed_paths(base_sha, root)
    deleted_entries = [
        path
        for status, path in changes
        if status == "D" and path.parent == PurePosixPath(".changeset") and path.suffix == ".md"
    ]
    if not deleted_entries or any(
        path.parent == PurePosixPath(".changeset") and path.suffix == ".md" and status != "D"
        for status, path in changes
    ):
        return False

    base_packages = workspace_packages(root, base_sha)
    head_packages = workspace_packages(root, "HEAD")
    deleted_targets: set[str] = set()
    for path in deleted_entries:
        parsed = parse_changeset(_git(root, "show", f"{base_sha}:{path.as_posix()}"))
        if parsed is None:
            return False
        deleted_targets.update(parsed)

    changed_versions: set[str] = set()
    changed_changelogs: set[str] = set()
    for status, path in changes:
        if path.parent == PurePosixPath(".changeset") and path.suffix == ".md":
            if status != "D":
                return False
            continue
        if path == PurePosixPath("pnpm-lock.yaml"):
            continue
        package_name = base_packages.get(path.parent) or head_packages.get(path.parent)
        if path.name == "package.json" and status == "M" and path.parent in base_packages and path.parent in head_packages:
            before = _package_data(root, base_sha, path.as_posix())
            after = json.loads((root / path).read_text(encoding="utf-8"))
            if not _version_only_manifest_change(before, after):
                return False
            if before.get("version") != after.get("version") and package_name:
                changed_versions.add(package_name)
            continue
        if path.name == "CHANGELOG.md" and status in {"A", "M"} and path.parent in head_packages:
            if package_name:
                changed_changelogs.add(package_name)
            continue
        return False

    return bool(changed_versions & changed_changelogs & deleted_targets)


def run_gate(base_sha: str, root: Path) -> None:
    if is_changesets_version_pr(base_sha, root):
        print(
            "Generated Changesets version PR detected: its consumed release entries and generated "
            "version/changelog changes are exempt from the source-PR Changesets gate."
        )
        return
    subprocess.run(
        ["pnpm", "changeset", "status", f"--since={base_sha}"], cwd=root, check=True
    )
    validate(base_sha, root)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_sha", help="Exact base commit SHA from the pull_request event")
    args = parser.parse_args()
    try:
        run_gate(args.base_sha, Path.cwd())
    except (OSError, subprocess.CalledProcessError, ValueError, yaml.YAMLError) as error:
        print(f"Changeset PR gate failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
