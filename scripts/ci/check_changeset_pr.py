"""Run Changesets' PR gate, allowing only generated Changesets version PRs through."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

import yaml

from check_changeset_package_scope import (
    FRONTMATTER,
    _git,
    _package_data,
    changed_paths,
    validate,
    workspace_packages,
)


DEPENDENCY_FIELDS = {
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
}
BUMP_ORDER = {"patch": 0, "minor": 1, "major": 2}
STABLE_VERSION = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
# Changesets accepts empty no-release entries with adjacent frontmatter delimiters.
EMPTY_CHANGESET = re.compile(r"\A---[ \t]*\r?\n---[ \t]*(?:\r?\n|\Z)")


def pull_request_merge_base(root: Path, github_sha: str) -> str:
    """Return the current target parent of GitHub's exact two-parent PR merge candidate."""
    head = _git(root, "rev-parse", "--verify", "HEAD^{commit}").strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", github_sha) or head != github_sha:
        raise ValueError("GITHUB_SHA does not identify the checked-out PR candidate")
    parents = _git(root, "rev-list", "--parents", "-n", "1", head).split()
    if len(parents) != 3 or parents[0] != head:
        raise ValueError("checked-out PR candidate is not an unambiguous two-parent merge commit")
    return parents[1]


def _changeset_bumps(text: str) -> dict[str, str] | None:
    match = FRONTMATTER.match(text)
    if not match:
        return {} if EMPTY_CHANGESET.match(text) else None
    parsed = yaml.safe_load(match.group(1))
    if parsed is None and not match.group(1).strip():
        return {}
    if not isinstance(parsed, dict) or any(
        not isinstance(name, str) or not isinstance(bump, str) or bump not in BUMP_ORDER
        for name, bump in parsed.items()
    ):
        return None
    return parsed


def _bumped_version(version: str, bump: str) -> str | None:
    """Calculate stable SemVer bumps; prerelease/snapshot flows are intentionally not exempt."""
    match = re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version)
    if not match or bump not in BUMP_ORDER:
        return None
    major, minor, patch = map(int, match.groups())
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def _version_only_manifest_change(
    package_root: str,
    before: dict,
    after: dict,
    released_versions: dict[str, str],
) -> set[tuple[str, str, str, str]] | None:
    """Return only exact simple workspace-range updates explained by a release."""
    allowed = DEPENDENCY_FIELDS | {"version"}
    if any(before.get(key) != after.get(key) for key in before.keys() | after.keys() if key not in allowed):
        return None
    if not isinstance(after.get("version"), str):
        return None
    changed_ranges: set[tuple[str, str, str, str]] = set()
    for field in DEPENDENCY_FIELDS:
        old_dependencies = before.get(field, {})
        new_dependencies = after.get(field, {})
        if not isinstance(old_dependencies, dict) or not isinstance(new_dependencies, dict):
            return None
        if old_dependencies.keys() != new_dependencies.keys():
            return None
        for name, old_value in old_dependencies.items():
            new_value = new_dependencies[name]
            if old_value == new_value:
                continue
            target_version = released_versions.get(name)
            old_range = old_value.removeprefix("workspace:") if isinstance(old_value, str) else ""
            range_match = re.fullmatch(rf"(?P<prefix>[~^]?)(?P<version>{STABLE_VERSION})", old_range)
            if not (
                target_version
                and isinstance(old_value, str)
                and isinstance(new_value, str)
                and old_value.startswith("workspace:")
                and new_value.startswith("workspace:")
                and range_match
                and new_value == f"workspace:{range_match.group('prefix')}{target_version}"
            ):
                return None
            changed_ranges.add((package_root, field, name, new_value))
    return changed_ranges


def _changelog_has_version(text: str, version: str) -> bool:
    return re.search(rf"(?m)^##[ \t]+{re.escape(version)}(?:[ \t]|$)", text) is not None


def _lockfile_changes_match_ranges(
    base_sha: str,
    root: Path,
    expected_ranges: set[tuple[str, str, str, str]],
) -> bool:
    """Allow only lockfile importer specifier edits backed by changed workspace ranges."""
    try:
        before_documents = list(yaml.safe_load_all(_git(root, "show", f"{base_sha}:pnpm-lock.yaml")))
        after_documents = list(
            yaml.safe_load_all((root / "pnpm-lock.yaml").read_text(encoding="utf-8"))
        )
    except (OSError, subprocess.CalledProcessError, yaml.YAMLError):
        return False
    if len(before_documents) != len(after_documents):
        return False
    remaining = set(expected_ranges)
    for before, after in zip(before_documents, after_documents, strict=True):
        if not isinstance(before, dict) or not isinstance(after, dict):
            return False
        if before.keys() != after.keys() or any(
            before[key] != after[key] for key in before.keys() if key != "importers"
        ):
            return False
        old_importers = before.get("importers")
        new_importers = after.get("importers")
        if not isinstance(old_importers, dict) or not isinstance(new_importers, dict):
            return False
        if old_importers.keys() != new_importers.keys():
            return False
        for importer, old_data in old_importers.items():
            new_data = new_importers[importer]
            if not isinstance(old_data, dict) or not isinstance(new_data, dict) or old_data.keys() != new_data.keys():
                return False
            for field in old_data:
                old_dependencies = old_data[field]
                new_dependencies = new_data[field]
                if field not in DEPENDENCY_FIELDS:
                    if old_dependencies != new_dependencies:
                        return False
                    continue
                if not isinstance(old_dependencies, dict) or not isinstance(new_dependencies, dict):
                    if old_dependencies != new_dependencies:
                        return False
                    continue
                if old_dependencies.keys() != new_dependencies.keys():
                    return False
                for dependency, old_entry in old_dependencies.items():
                    new_entry = new_dependencies[dependency]
                    if old_entry == new_entry:
                        continue
                    if not isinstance(old_entry, dict) or not isinstance(new_entry, dict):
                        return False
                    expected = (importer, field, dependency, new_entry.get("specifier"))
                    if (
                        expected not in remaining
                        or not isinstance(new_entry.get("specifier"), str)
                        or {key: value for key, value in old_entry.items() if key != "specifier"}
                        != {key: value for key, value in new_entry.items() if key != "specifier"}
                    ):
                        return False
                    remaining.remove(expected)
    return not remaining


def is_changesets_version_pr(base_sha: str, root: Path) -> bool:
    return _is_changesets_version_pr(base_sha, root, changed_paths(base_sha, root))


def _is_changesets_version_pr(
    base_sha: str, root: Path, changes: list[tuple[str, PurePosixPath]]
) -> bool:
    """Recognize a generated version-only PR by its consumed entries and output shape."""
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
    target_bumps: dict[str, str] = {}
    for path in deleted_entries:
        parsed = _changeset_bumps(_git(root, "show", f"{base_sha}:{path.as_posix()}"))
        if parsed is None:
            return False
        if not parsed:
            continue
        for name, bump in parsed.items():
            if name not in target_bumps or BUMP_ORDER[bump] > BUMP_ORDER[target_bumps[name]]:
                target_bumps[name] = bump
    if not target_bumps:
        return False

    changed_versions: dict[str, str] = {}
    versioned_manifests: dict[PurePosixPath, tuple[dict, dict]] = {}
    for status, path in changes:
        if path.name != "package.json" or status != "M":
            continue
        if path.parent not in base_packages or path.parent not in head_packages:
            return False
        before = _package_data(root, base_sha, path.as_posix())
        after = json.loads((root / path).read_text(encoding="utf-8"))
        version = after.get("version")
        if before.get("version") != version:
            package_name = base_packages[path.parent]
            if package_name != head_packages[path.parent] or not isinstance(version, str):
                return False
            changed_versions[package_name] = version
        versioned_manifests[path.parent] = (before, after)

    if not changed_versions or not target_bumps.keys() <= changed_versions.keys():
        return False

    expected_ranges: set[tuple[str, str, str, str]] = set()
    for package_root, (before, after) in versioned_manifests.items():
        ranges = _version_only_manifest_change(
            package_root.as_posix(), before, after, changed_versions
        )
        if ranges is None:
            return False
        expected_ranges.update(ranges)

    update_config = _package_data(root, base_sha, ".changeset/config.json")
    dependent_bump = update_config.get("updateInternalDependencies", "patch")
    if not isinstance(dependent_bump, str) or dependent_bump not in BUMP_ORDER:
        return False
    release_plan_packages = set(target_bumps)
    # Changesets propagates releases through workspace dependents even when a
    # workspace protocol range does not need changing (for example, `^1.0.0`
    # remains valid after a patch). Validate that propagation as a dependency
    # closure rather than requiring every dependent to have a changed range.
    while True:
        previous = len(release_plan_packages)
        for package_root, (before, _) in versioned_manifests.items():
            package_name = base_packages.get(package_root)
            if package_name not in changed_versions:
                continue
            dependencies = set().union(
                *(
                    before.get(field, {}).keys()
                    for field in DEPENDENCY_FIELDS
                    if isinstance(before.get(field, {}), dict)
                )
            )
            if dependencies & release_plan_packages:
                release_plan_packages.add(package_name)
        if len(release_plan_packages) == previous:
            break
    for package_root, field, dependency, _ in expected_ranges:
        package_name = base_packages.get(PurePosixPath(package_root))
        if package_name not in changed_versions or dependency not in changed_versions:
            return False
    if set(changed_versions) - release_plan_packages:
        return False

    versions_before = {
        base_packages[path]: before.get("version")
        for path, (before, _) in versioned_manifests.items()
        if path in base_packages
    }
    for name, new_version in changed_versions.items():
        bump = target_bumps.get(name, "patch")
        if _bumped_version(str(versions_before.get(name, "")), bump) != new_version:
            return False

    changed_changelogs: dict[str, str] = {}
    for status, path in changes:
        if path.parent == PurePosixPath(".changeset") and path.suffix == ".md":
            if status != "D":
                return False
            continue
        if path == PurePosixPath("pnpm-lock.yaml"):
            continue
        package_name = base_packages.get(path.parent) or head_packages.get(path.parent)
        if path.name == "package.json" and status == "M" and path.parent in base_packages and path.parent in head_packages:
            continue
        if path.name == "CHANGELOG.md" and status in {"A", "M"} and path.parent in head_packages:
            if package_name:
                changed_changelogs[package_name] = (root / path).read_text(encoding="utf-8")
            continue
        return False

    if set(changed_changelogs) != set(changed_versions):
        return False
    if any(
        not _changelog_has_version(changed_changelogs[name], version)
        for name, version in changed_versions.items()
    ):
        return False
    lockfile_changed = any(path == PurePosixPath("pnpm-lock.yaml") for _, path in changes)
    if lockfile_changed and not _lockfile_changes_match_ranges(base_sha, root, expected_ranges):
        return False
    return bool(changed_versions and set(changed_versions) & target_bumps.keys())


def working_tree_changes(base_sha: str, root: Path) -> list[tuple[str, PurePosixPath]]:
    """Return all tracked and untracked candidate changes against the exact base."""
    head = _git(root, "rev-parse", "--verify", "HEAD^{commit}").strip()
    if head != base_sha:
        raise ValueError("working-tree candidate requires HEAD to equal the trusted base")
    fields = _git(root, "diff", "--name-status", "-z", "--no-renames", base_sha, "--").split("\0")
    changes: list[tuple[str, PurePosixPath]] = []
    index = 0
    while index < len(fields) and fields[index]:
        changes.append((fields[index][0], PurePosixPath(fields[index + 1])))
        index += 2
    untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    changes.extend(("A", PurePosixPath(path)) for path in untracked if path)
    return changes


def is_working_tree_changesets_version_candidate(base_sha: str, root: Path) -> bool:
    """Validate release output without staging or committing generated artifacts."""
    # Reuse the exact committed-candidate checks with a temporary candidate-independent
    # change list; all data reads still use the working tree and trusted base.
    return _is_changesets_version_pr(base_sha, root, working_tree_changes(base_sha, root))


def run_gate(
    base_sha: str,
    root: Path,
    excluded_paths: list[str] | None = None,
    workspace_head_sha: str = "HEAD",
) -> bool:
    if is_changesets_version_pr(base_sha, root):
        print(
            "Generated Changesets version PR detected: its consumed release entries and generated "
            "version/changelog changes are exempt from the source-PR Changesets gate."
        )
        return True
    subprocess.run(
        ["pnpm", "changeset", "status", f"--since={base_sha}"], cwd=root, check=True
    )
    validate(base_sha, root, excluded_paths, workspace_head_sha)
    return False


def run_working_tree_gate(base_sha: str, root: Path) -> None:
    if not is_working_tree_changesets_version_candidate(base_sha, root):
        raise ValueError("working-tree output is not a valid generated Changesets version candidate")
    print("Generated Changesets working-tree candidate validated against the trusted base.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("base_sha", nargs="?", help="Exact base commit SHA")
    source.add_argument(
        "--working-tree-generated-candidate",
        metavar="BASE_SHA",
        help="validate unstaged release output against exact trusted base (release wrapper only)",
    )
    source.add_argument(
        "--pull-request-merge-base",
        metavar="GITHUB_SHA",
        help="derive the current target from the checked-out GitHub PR merge candidate",
    )
    parser.add_argument(
        "--exclude-path", action="append", default=[],
        help="Workflow-configured workspace path glob exempt only when all changed paths match",
    )
    parser.add_argument(
        "--workspace-head-sha",
        help="Exact PR head used for head-only workspace discovery and changed-path mapping",
    )
    args = parser.parse_args()
    try:
        root = Path.cwd()
        base_sha = (
            pull_request_merge_base(root, args.pull_request_merge_base)
            if args.pull_request_merge_base
            else args.base_sha or args.working_tree_generated_candidate
        )
        if args.working_tree_generated_candidate:
            run_working_tree_gate(base_sha, root)
        else:
            generated = run_gate(
                base_sha, root, args.exclude_path, args.workspace_head_sha or "HEAD"
            )
            output = os.environ.get("GITHUB_OUTPUT")
            if output:
                with Path(output).open("a", encoding="utf-8") as github_output:
                    github_output.write(f"generated-version-pr={str(generated).lower()}\n")
    except (OSError, subprocess.CalledProcessError, ValueError, yaml.YAMLError) as error:
        print(f"Changeset PR gate failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
