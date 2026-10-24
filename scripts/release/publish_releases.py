"""Create GitHub package tags and Releases for a verified Changesets merge."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ci"))

from check_changeset_package_scope import (  # noqa: E402
    _package_data,
    changed_paths,
    workspace_packages,
)
from check_changeset_pr import STABLE_VERSION, is_changesets_version_pr  # noqa: E402
from release_common import (  # noqa: E402
    GitHubReleaseClient,
    PackageRelease,
    ReleaseError,
    publish_release,
    verify_app_identity,
)


PACKAGE_NAME = re.compile(r"(?:@[a-z0-9._~-]+/)?[a-z0-9._~-]+\Z")
CHANGELOG_HEADING = re.compile(r"^##[ \t]+([^\r\n]+?)[ \t]*#*[ \t]*$", re.MULTILINE)


def changelog_section(text: str, version: str) -> str:
    """Extract exactly one version's Markdown notes, excluding neighboring releases."""
    headings = list(CHANGELOG_HEADING.finditer(text))
    for index, heading in enumerate(headings):
        if heading.group(1) != version:
            continue
        end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
        notes = text[heading.end() : end].strip()
        if not notes:
            raise ReleaseError(f"CHANGELOG.md has no release notes for version {version}.")
        return notes
    raise ReleaseError(f"CHANGELOG.md is missing the exact version heading {version!r}.")


def release_plan(base_sha: str, commit_sha: str, root: Path = ROOT) -> list[PackageRelease]:
    """Validate the complete generated-PR shape before allowing any remote write."""
    if not re.fullmatch(r"[0-9a-f]{40}", base_sha) or not re.fullmatch(
        r"[0-9a-f]{40}", commit_sha
    ):
        raise ReleaseError("The release base and merge commit must be full Git object IDs.")
    actual_head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
    ).stdout.strip()
    if actual_head != commit_sha:
        raise ReleaseError(
            "The checked-out commit does not match the confirmed pull-request merge commit."
        )
    first_parent = subprocess.run(
        ["git", "rev-parse", f"{commit_sha}^1"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if first_parent != base_sha:
        raise ReleaseError("The release base is not the confirmed merge commit's first parent.")
    if not is_changesets_version_pr(base_sha, root):
        raise ReleaseError("The merged change is not a valid generated Changesets version PR.")

    changes = changed_paths(base_sha, root)
    base_packages = workspace_packages(root, base_sha)
    head_packages = workspace_packages(root, "HEAD")
    versions: dict[str, str] = {}
    changelogs: dict[str, str] = {}
    for status, path in changes:
        if path.name == "package.json" and status == "M" and path.parent in base_packages:
            before = _package_data(root, base_sha, path.as_posix())
            after = _package_data(root, "HEAD", path.as_posix())
            old_version = before.get("version")
            new_version = after.get("version")
            if old_version != new_version:
                package = base_packages[path.parent]
                if package != head_packages.get(path.parent):
                    raise ReleaseError(
                        f"Package identity changed in generated version PR: {path.parent}."
                    )
                if not isinstance(new_version, str) or not re.fullmatch(
                    STABLE_VERSION, new_version
                ):
                    raise ReleaseError(f"Package {package!r} has an unsupported release version.")
                versions[package] = new_version
        if (
            path.name == "CHANGELOG.md"
            and status in {"A", "M"}
            and path.parent in head_packages
        ):
            changelogs[head_packages[path.parent]] = (root / path).read_text(encoding="utf-8")

    if not versions or versions.keys() != changelogs.keys():
        raise ReleaseError("Generated package versions and changelogs do not match exactly.")

    artifacts: list[PackageRelease] = []
    for package, version in sorted(versions.items()):
        if not PACKAGE_NAME.fullmatch(package):
            raise ReleaseError(f"Package name {package!r} cannot be represented as a release tag.")
        tag = f"{package}@{version}"
        artifacts.append(
            PackageRelease(
                package=package,
                version=version,
                tag=tag,
                notes=changelog_section(changelogs[package], version),
            )
        )
    return artifacts


def verify_merged_version_pr(
    client: GitHubReleaseClient,
    pull_number: int,
    merge_commit_sha: str,
    expected_app_slug: str,
) -> None:
    """Bind release writes to the configured App's same-repository merged PR."""
    if pull_number <= 0 or not expected_app_slug:
        raise ReleaseError("The merged version PR identity is not configured.")
    status, pull = client.request("GET", f"pulls/{pull_number}")
    if status != 200 or not isinstance(pull, dict):
        raise ReleaseError(f"Could not verify merged version PR #{pull_number} (HTTP {status}).")
    head = pull.get("head")
    base = pull.get("base")
    author = pull.get("user")
    head_repo = head.get("repo") if isinstance(head, dict) else None
    base_repo = base.get("repo") if isinstance(base, dict) else None
    if (
        pull.get("state") != "closed"
        or pull.get("merged") is not True
        or pull.get("merge_commit_sha") != merge_commit_sha
        or not isinstance(head, dict)
        or head.get("ref") not in {"changeset-release/main", "changesets/version"}
        or not isinstance(head_repo, dict)
        or head_repo.get("full_name") != "grasdouble/Jarvis"
        or not isinstance(base, dict)
        or base.get("ref") != "main"
        or not isinstance(base_repo, dict)
        or base_repo.get("full_name") != "grasdouble/Jarvis"
        or not isinstance(author, dict)
        or author.get("login") != f"{expected_app_slug}[bot]"
    ):
        raise ReleaseError("The merged PR is not the configured App's version PR into main.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-sha", required=True, help="First parent of the confirmed merge commit"
    )
    parser.add_argument(
        "--commit-sha", required=True, help="Exact confirmed version-PR merge commit"
    )
    parser.add_argument(
        "--pull-number", required=True, type=int, help="Confirmed merged version PR number"
    )
    args = parser.parse_args()
    try:
        token = os.environ.pop("GH_TOKEN", "")
        for name in ("GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
            os.environ.pop(name, None)
        # The strict diff and manifest inspection subprocesses need no credentials.
        artifacts = release_plan(args.base_sha, args.commit_sha)
        verify_app_identity(os.environ)
        app_slug = os.environ.get("PACKAGE_RELEASE_APP_SLUG", "")
        client = GitHubReleaseClient(token)
        verify_merged_version_pr(client, args.pull_number, args.commit_sha, app_slug)
        for artifact in artifacts:
            publish_release(client, artifact, args.commit_sha)
            print(f"Verified GitHub Release {artifact.tag} at {args.commit_sha}.")
    except (OSError, subprocess.CalledProcessError, ReleaseError, ValueError) as error:
        print(f"Package release failed closed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
