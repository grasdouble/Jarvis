"""Require a PR Changeset for every changed versionable workspace."""

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


def changed_paths(base_sha: str, root: Path, head_sha: str = "HEAD") -> list[tuple[str, PurePosixPath]]:
    """Return status/path pairs, disabling rename detection so both sides are visible."""
    fields = _git(
        root, "diff", "--name-status", "-z", "--no-renames", f"{base_sha}...{head_sha}"
    ).split("\0")
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


def changed_file_paths(base_sha: str, head_sha: str, root: Path) -> list[PurePosixPath]:
    """Match the pinned Lufa action's diff-visible paths, including rename handling."""
    fields = _git(root, "diff", "--name-only", "-z", f"{base_sha}...{head_sha}").split("\0")
    return [PurePosixPath(path) for path in fields if path]


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


def workspace_packages(
    root: Path, ref: str = "HEAD", versionable_only: bool = True
) -> dict[PurePosixPath, str]:
    """Discover named workspace packages at an exact Git revision."""
    workspace = yaml.safe_load(_git(root, "show", f"{ref}:pnpm-workspace.yaml"))
    if versionable_only:
        try:
            changeset_config = _package_data(root, ref, ".changeset/config.json")
        except subprocess.CalledProcessError:
            # Fall back only for legacy generated-release fixtures without candidate config.
            changeset_config = _package_data(root, "HEAD", ".changeset/config.json")
        private_versions = changeset_config.get("privatePackages", {}).get("version", False)
        ignored = set(changeset_config.get("ignore", []))
    else:
        private_versions = True
        ignored = set()
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


def head_changeset_targets(root: Path, head_sha: str) -> set[str]:
    """Return all release targets in Changesets present at the exact PR head."""
    paths = _git(root, "ls-tree", "-r", "--name-only", "-z", head_sha, ".changeset").split("\0")
    targets: set[str] = set()
    for raw_path in paths:
        if not raw_path or not raw_path.endswith(".md") or raw_path == ".changeset/README.md":
            continue
        parsed = parse_changeset(_git(root, "show", f"{head_sha}:{raw_path}"))
        if parsed is not None:
            targets.update(parsed)
    return targets


def changeset_coverage_error(changed: set[str], entries: list[set[str]]) -> str | None:
    if not changed:
        return None
    covered = set().union(*entries) if entries else set()
    missing = changed - covered
    if not missing:
        return None
    changed_list = ", ".join(sorted(missing))
    if covered:
        covered_list = ", ".join(sorted(covered))
        return (
            f"Changed versionable workspaces ({changed_list}) are not targeted by the PR's Changesets "
            f"({covered_list}). Add a Changeset targeting each changed workspace."
        )
    return (
        f"Changed versionable workspaces ({changed_list}) need individual Changeset coverage."
    )


def validate(
    base_sha: str,
    root: Path,
    excluded_paths: list[str] | None = None,
    head_sha: str = "HEAD",
) -> str:
    changes = changed_paths(base_sha, root, head_sha)
    paths = changed_file_paths(base_sha, head_sha, root)
    head_packages = workspace_packages(root, head_sha, versionable_only=False)
    head_names = set(head_packages.values())
    stale_targets = head_changeset_targets(root, head_sha) - head_names
    if stale_targets:
        raise ValueError(
            "Changesets at PR head target packages absent from the PR-head workspace set: "
            + ", ".join(sorted(stale_targets))
            + ". Remove stale targets."
        )
    excluded_paths = excluded_paths or []
    changed: set[str] = set()
    for package_root, name in head_packages.items():
        package_paths = [path for path in paths if package_root in path.parents]
        if any(
            not any(_path_matches_glob(path.as_posix(), pattern) for pattern in excluded_paths)
            for path in package_paths
        ):
            changed.add(name)
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
    parser.add_argument(
        "--exclude-path", action="append", default=[],
        help="Workflow-configured workspace path glob; exempt only when every changed path matches one",
    )
    args = parser.parse_args()
    try:
        validate(args.base_sha, Path.cwd(), args.exclude_path)
    except (OSError, subprocess.CalledProcessError, ValueError, yaml.YAMLError) as error:
        print(f"Changeset package coverage failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
