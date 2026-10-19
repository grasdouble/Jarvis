"""Consume pending Changesets and maintain the reviewed version PR."""

from __future__ import annotations

import os
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode

from release_common import (
    REPOSITORY,
    VERSION_BRANCH,
    VERSION_PR_TITLE,
    GitHubReleaseClient,
    ReleaseError,
    github_app_environment,
    safe_process,
    verify_app_identity,
)


ROOT = Path(__file__).resolve().parents[2]
REMOTE_URL = "https://github.com/grasdouble/Jarvis.git"
BOT_EMAIL = "github-actions[bot]@users.noreply.github.com"


def _git(
    command: list[str], environment: dict[str, str], check: bool = True
) -> subprocess.CompletedProcess[str]:
    return safe_process(
        [
            "git",
            "-c",
            "credential.helper=",
            "-c",
            "credential.username=x-access-token",
            *command,
        ],
        cwd=ROOT,
        env=environment,
        check=check,
    )


def _check_generated_paths(environment: dict[str, str]) -> bool:
    status = _git(["status", "--porcelain=v1"], environment).stdout
    if not status.strip():
        return False
    version_bump = False
    for line in status.splitlines():
        if len(line) < 4:
            raise ReleaseError("Could not safely classify generated version changes.")
        path = line[3:].strip().strip('"')
        package_path = re.fullmatch(r"(?:apps|packages)/.+/package\.json", path)
        changelog_path = re.fullmatch(r"(?:apps|packages)/.+/CHANGELOG\.md", path)
        changeset_path = re.fullmatch(r"\.changeset/[^/]+\.md", path)
        if not (package_path or changelog_path or changeset_path or path == "pnpm-lock.yaml"):
            raise ReleaseError(f"Changesets generated an unexpected path: {path!r}.")
        if package_path:
            before_text = _git(["show", f"HEAD:{path}"], environment).stdout
            before = json.loads(before_text)
            after = json.loads((ROOT / path).read_text(encoding="utf-8"))
            version_bump = version_bump or before.get("version") != after.get("version")
    return version_bump


def _pull_request(api: GitHubReleaseClient) -> dict | None:
    query = urlencode(
        {"state": "open", "head": f"grasdouble:{VERSION_BRANCH}", "base": "main"}
    )
    status, result = api.request("GET", f"pulls?{query}")
    if status != 200 or not isinstance(result, list):
        raise ReleaseError(f"Could not inspect the generated version PR (HTTP {status}).")
    if len(result) > 1:
        raise ReleaseError("More than one open Changesets version PR uses the reserved branch.")
    return result[0] if result else None


def _most_recent_pull_request(api: GitHubReleaseClient) -> dict | None:
    query = urlencode(
        {
            "state": "all",
            "head": f"grasdouble:{VERSION_BRANCH}",
            "base": "main",
            "per_page": "1",
            "sort": "updated",
            "direction": "desc",
        }
    )
    status, result = api.request("GET", f"pulls?{query}")
    if status != 200 or not isinstance(result, list):
        raise ReleaseError(f"Could not inspect version PR history (HTTP {status}).")
    return result[0] if result else None


def _verify_pull_request(pull: dict, slug: str) -> None:
    head = pull.get("head")
    base = pull.get("base")
    author = pull.get("user")
    if not isinstance(head, dict) or not isinstance(base, dict) or not isinstance(author, dict):
        raise ReleaseError("The existing generated version PR has incomplete identity metadata.")
    head_repo = head.get("repo")
    base_repo = base.get("repo")
    if (
        head.get("ref") != VERSION_BRANCH
        or not isinstance(head_repo, dict)
        or head_repo.get("full_name") != REPOSITORY
        or base.get("ref") != "main"
        or not isinstance(base_repo, dict)
        or base_repo.get("full_name") != REPOSITORY
        or author.get("login") != f"{slug}[bot]"
    ):
        raise ReleaseError(
            "The reserved version PR is not owned by the configured package-release App."
        )


def authorize_branch_update(
    open_pull: dict | None,
    previous_pull: dict | None,
    remote_sha: str | None,
    candidate_sha: str,
    slug: str,
) -> None:
    """Refuse to replace a reserved branch without a verifiable App-owned PR history."""
    if open_pull is not None:
        _verify_pull_request(open_pull, slug)
        return
    if previous_pull is not None:
        _verify_pull_request(previous_pull, slug)
        if previous_pull.get("state") != "closed" or previous_pull.get("merged") is not True:
            raise ReleaseError(
                "A previously closed, unmerged version PR will not be reopened or overwritten."
            )
        return
    if remote_sha is not None and remote_sha != candidate_sha:
        raise ReleaseError(
            "The reserved version branch exists without a verifiable App-owned PR; "
            "refusing to overwrite it."
        )


def _remote_branch_sha(api: GitHubReleaseClient) -> str | None:
    status, result = api.request("GET", "git/ref/heads/changesets/version")
    if status == 404:
        return None
    if status != 200 or not isinstance(result, dict):
        raise ReleaseError(f"Could not inspect the generated version branch (HTTP {status}).")
    object_data = result.get("object")
    if not isinstance(object_data, dict) or not isinstance(object_data.get("sha"), str):
        raise ReleaseError("The generated version branch has malformed ref metadata.")
    return object_data["sha"]


def _api_main_sha(api: GitHubReleaseClient) -> str:
    status, result = api.request("GET", "branches/main")
    if status != 200 or not isinstance(result, dict):
        raise ReleaseError(
            f"Could not inspect main before updating the version PR (HTTP {status})."
        )
    commit = result.get("commit")
    if not isinstance(commit, dict) or not isinstance(commit.get("sha"), str):
        raise ReleaseError("The main branch response did not contain a commit SHA.")
    return commit["sha"]


def _pr_body() -> str:
    return """## Summary

Consume pending Changesets and update package versions, changelogs, and internal workspace ranges
for review.

## Issue

Refs #32 (automatically generated release PR; it does not close the delivery issue).

## Specification and decision impact

- Trusted source: the reviewed `main` branch and `.changeset/config.json`.
- Disposition: aligned with independent private package versioning; no npm publication or product
  deployment.
- Implemented output: generated package versions/changelogs and lockfile changes, when needed.
- No owner decision is inferred by this generated PR.

## Verification

- Generated by the pinned repository workflow from pending Changesets.
- Required current-head repository checks validate the generated version-only diff.

## Independent review

- Human review and all native repository protections remain applicable.

## Risks and follow-up

- Merge this PR to create package tags and GitHub Releases from its exact merge commit.
- Package versions do not establish the product v0.1 MVP acceptance gate.
"""


def run() -> None:
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ReleaseError("The version PR workflow is restricted to grasdouble/Jarvis.")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ReleaseError("The version PR workflow must run from trusted main.")

    token = os.environ.get("GH_TOKEN", "")
    slug = os.environ.get("PACKAGE_RELEASE_APP_SLUG", "")
    verify_app_identity(os.environ)
    if not slug:
        raise ReleaseError("PACKAGE_RELEASE_APP_SLUG is not configured.")

    # Package-manager and validation subprocesses never inherit the write token.
    command_environment = os.environ.copy()
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
        command_environment.pop(name, None)
    command_environment["GIT_CONFIG_GLOBAL"] = os.devnull
    command_environment["GIT_CONFIG_NOSYSTEM"] = "1"
    if _git(["status", "--porcelain=v1"], command_environment).stdout.strip():
        raise ReleaseError("The trusted main checkout must be clean before version generation.")
    url_rewrites = _git(
        ["config", "--local", "--get-regexp", r"^url\..*\.insteadof$"],
        command_environment,
        check=False,
    ).stdout
    if url_rewrites:
        raise ReleaseError("Local Git URL rewrites are not allowed for package-release writes.")

    base_sha = _git(["rev-parse", "HEAD"], command_environment).stdout.strip()
    safe_process(["pnpm", "changeset", "version"], cwd=ROOT, env=command_environment)
    safe_process(["pnpm", "install", "--lockfile-only"], cwd=ROOT, env=command_environment)
    safe_process(["pnpm", "install", "--frozen-lockfile"], cwd=ROOT, env=command_environment)
    if not _check_generated_paths(command_environment):
        print("No pending Changesets; no version PR update is needed.")
        return

    _git(["add", "--all"], command_environment)
    stable_date = _git(
        ["show", "-s", "--format=%cI", base_sha], command_environment
    ).stdout.strip()
    commit_environment = command_environment.copy()
    commit_environment["GIT_AUTHOR_DATE"] = stable_date
    commit_environment["GIT_COMMITTER_DATE"] = stable_date
    commit_environment["GIT_AUTHOR_NAME"] = "github-actions[bot]"
    commit_environment["GIT_AUTHOR_EMAIL"] = BOT_EMAIL
    commit_environment["GIT_COMMITTER_NAME"] = "github-actions[bot]"
    commit_environment["GIT_COMMITTER_EMAIL"] = BOT_EMAIL
    _git(
        [
            "-c",
            "user.name=github-actions[bot]",
            "-c",
            f"user.email={BOT_EMAIL}",
            "commit",
            "--message",
            VERSION_PR_TITLE,
        ],
        commit_environment,
    )
    candidate_sha = _git(["rev-parse", "HEAD"], command_environment).stdout.strip()
    safe_process(
        [sys.executable, str(ROOT / "scripts/ci/check_changeset_pr.py"), base_sha],
        cwd=ROOT,
        env=command_environment,
    )

    api = GitHubReleaseClient(token)
    if _api_main_sha(api) != base_sha:
        raise ReleaseError(
            "main advanced during version generation; wait for its next workflow run."
        )
    pull = _pull_request(api)
    old_sha = _remote_branch_sha(api)
    previous_pull = None if pull is not None else _most_recent_pull_request(api)
    authorize_branch_update(pull, previous_pull, old_sha, candidate_sha, slug)
    if old_sha is not None:
        # Fetch only the reserved branch, then update it by a fast-forward merge commit.
        with github_app_environment(token) as auth_environment:
            _git(
                [
                    "fetch",
                    "--no-tags",
                    REMOTE_URL,
                    f"+refs/heads/{VERSION_BRANCH}:refs/remotes/origin/{VERSION_BRANCH}",
                ],
                auth_environment,
            )
            same_tree = _git(
                ["diff", "--quiet", f"{old_sha}^{{tree}}", f"{candidate_sha}^{{tree}}"],
                command_environment,
                check=False,
            ).returncode == 0
            if not same_tree:
                tree_sha = _git(
                    ["rev-parse", f"{candidate_sha}^{{tree}}"], command_environment
                ).stdout.strip()
                candidate_sha = _git(
                    [
                        "-c",
                        "user.name=github-actions[bot]",
                        "-c",
                        f"user.email={BOT_EMAIL}",
                        "commit-tree",
                        tree_sha,
                        "-p",
                        base_sha,
                        "-p",
                        old_sha,
                        "-m",
                        VERSION_PR_TITLE,
                    ],
                    commit_environment,
                ).stdout.strip()
                _git(["checkout", "--detach", candidate_sha], command_environment)
                safe_process(
                    [sys.executable, str(ROOT / "scripts/ci/check_changeset_pr.py"), base_sha],
                    cwd=ROOT,
                    env=command_environment,
                )
                _git(
                    [
                        "push",
                        REMOTE_URL,
                        f"{candidate_sha}:refs/heads/{VERSION_BRANCH}",
                    ],
                    auth_environment,
                )
    else:
        with github_app_environment(token) as auth_environment:
            _git(
                [
                    "push",
                    REMOTE_URL,
                    f"{candidate_sha}:refs/heads/{VERSION_BRANCH}",
                ],
                auth_environment,
            )

    if pull is not None:
        print(f"Updated the existing Changesets version PR #{pull.get('number')}.")
        return

    status, created = api.request(
        "POST",
        "pulls",
        {"title": VERSION_PR_TITLE, "head": VERSION_BRANCH, "base": "main", "body": _pr_body()},
    )
    if (
        status != 201
        or not isinstance(created, dict)
        or not isinstance(created.get("number"), int)
    ):
        # A retry may find that GitHub accepted the creation before the response was lost.
        reconciled = _pull_request(api)
        if reconciled is None:
            raise ReleaseError(f"Could not create the Changesets version PR (HTTP {status}).")
        _verify_pull_request(reconciled, slug)
        print(f"Reconciled the existing Changesets version PR #{reconciled.get('number')}.")
        return
    print(f"Created Changesets version PR #{created['number']}.")


def main() -> int:
    try:
        run()
    except (OSError, subprocess.CalledProcessError, ReleaseError, ValueError) as error:
        print(f"Version PR automation failed closed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
