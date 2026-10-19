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


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True
    )
    return result.stdout


def changed_paths(base_sha: str, root: Path) -> list[tuple[str, PurePosixPath]]:
    """Return status/path pairs, disabling rename detection so both sides are visible."""
    fields = _git(root, "diff", "--name-status", "-z", "--no-renames", f"{base_sha}...HEAD").split("\0")
    changes: list[tuple[str, PurePosixPath]] = []
    index = 0
    while index < len(fields) and fields[index]:
        status = fields[index]
        index += 1
        path_count = 2 if status.startswith(("R", "C")) else 1
        for path in fields[index : index + path_count]:
            changes.append((status[0], PurePosixPath(path)))
        index += path_count
    return changes


def _workspace_manifest_paths(root: Path, ref: str, patterns: list[str]) -> list[PurePosixPath]:
    paths = _git(root, "ls-tree", "-r", "--name-only", "-z", ref).split("\0")
    return [
        PurePosixPath(path)
        for path in paths
        if path.endswith("/package.json")
        and _matches_workspace_manifest(PurePosixPath(path), patterns)
    ]


def _package_data(root: Path, ref: str, path: str) -> dict:
    return json.loads(_git(root, "show", f"{ref}:{path}"))


def _matches_workspace_manifest(path: PurePosixPath, patterns: list[str]) -> bool:
    included = False
    excluded = False
    for pattern in patterns:
        is_exclusion = pattern.startswith("!")
        glob = pattern[1:] if is_exclusion else pattern
        manifest_glob = glob.rstrip("/") + "/package.json"
        if any(_path_matches_glob(path.as_posix(), expanded) for expanded in _expand_braces(manifest_glob)):
            if is_exclusion:
                excluded = True
            else:
                included = True
    return included and not excluded


def _expand_braces(pattern: str) -> list[str]:
    """Expand simple comma-separated glob braces, as used by PNPM workspace patterns."""
    start = pattern.find("{")
    if start < 0:
        return [pattern]
    depth = 0
    alternatives: list[str] = []
    alternative_start = start + 1
    end = -1
    for index in range(start + 1, len(pattern)):
        char = pattern[index]
        if char == "{":
            depth += 1
        elif char == "}" and depth:
            depth -= 1
        elif char == "}" and not depth:
            alternatives.append(pattern[alternative_start:index])
            end = index
            break
        elif char == "," and not depth:
            alternatives.append(pattern[alternative_start:index])
            alternative_start = index + 1
    if end < 0 or len(alternatives) < 2:
        return [pattern]
    expanded = [pattern[:start] + value + pattern[end + 1 :] for value in alternatives]
    return [result for item in expanded for result in _expand_braces(item)]


def _path_matches_glob(path: str, pattern: str) -> bool:
    """Match a POSIX path using globstar semantics (`**/` matches zero or more dirs)."""
    parts = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*" and pattern[index : index + 2] == "**":
            index += 2
            if index < len(pattern) and pattern[index] == "/":
                parts.append("(?:.*/)?")
                index += 1
            else:
                parts.append(".*")
        elif char == "*":
            parts.append("[^/]*")
            index += 1
        elif char == "?":
            parts.append("[^/]")
            index += 1
        elif char == "[":
            end = pattern.find("]", index + 1)
            if end < 0:
                parts.append(r"\[")
                index += 1
                continue
            content = pattern[index + 1 : end]
            if content.startswith("!"):
                content = "^" + content[1:]
            elif content.startswith("^"):
                content = "\\" + content
            parts.append("[" + content.replace("\\", "\\\\") + "]")
            index = end + 1
        else:
            parts.append(re.escape(char))
            index += 1
    parts.append("$")
    return re.match("".join(parts), path) is not None


def workspace_packages(root: Path, ref: str = "HEAD") -> dict[PurePosixPath, str]:
    """Discover versionable workspace packages at an exact Git revision."""
    workspace = yaml.safe_load(_git(root, "show", f"{ref}:pnpm-workspace.yaml"))
    try:
        changeset_config = _package_data(root, ref, ".changeset/config.json")
    except subprocess.CalledProcessError:
        # The Changesets config may itself be introduced by the PR; use the
        # candidate policy to classify the base-side workspace manifests.
        changeset_config = _package_data(root, "HEAD", ".changeset/config.json")
    private_versions = changeset_config.get("privatePackages", {}).get("version", False)
    ignored = set(changeset_config.get("ignore", []))
    packages: dict[PurePosixPath, str] = {}
    patterns = workspace.get("packages", [])
    for manifest_path in _workspace_manifest_paths(root, ref, patterns):
        manifest = _package_data(root, ref, manifest_path.as_posix())
        name = manifest.get("name")
        if not isinstance(name, str) or name in ignored:
            continue
        if manifest.get("private", False) and not private_versions:
            continue
        packages[manifest_path.parent] = name
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
    changes = changed_paths(base_sha, root)
    paths = [path for _, path in changes]
    base_packages = workspace_packages(root, base_sha)
    head_packages = workspace_packages(root, "HEAD")
    changed = changed_workspace_names(paths, base_packages)
    changed.update(changed_workspace_names(paths, head_packages))
    if PurePosixPath("pnpm-workspace.yaml") in paths:
        for package_root in base_packages.keys() | head_packages.keys():
            base_name = base_packages.get(package_root)
            head_name = head_packages.get(package_root)
            if base_name != head_name:
                if base_name:
                    changed.add(base_name)
                if head_name:
                    changed.add(head_name)
    entries = []
    for status, path in changes:
        if status == "D" or path.parent != PurePosixPath(".changeset") or path.suffix != ".md":
            continue
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
