"""Fail-closed authorization for the Lufa-managed Changesets PR branch."""

import os
import sys
from urllib.parse import urlencode

from release_common import GitHubReleaseClient, ReleaseError


REPOSITORY = "grasdouble/Jarvis"
VERSION_BRANCH = "changeset-release/main"
VERSION_PR_TITLE = "build(release): update package versions"
RELEASE_RULESET_NAME = "Changesets release branch — package release App"
RELEASE_BRANCH_REF = "refs/heads/changeset-release/main"
REQUIRED_RULE_TYPES = {"creation", "update", "deletion", "non_fast_forward"}


def verify_release_branch_ruleset(api) -> None:
    """Verify the uniquely named active ruleset and exact managed branch scope."""
    listing_status, rulesets = api.request(
        "GET", "rulesets?per_page=100&includes_parents=true"
    )
    if listing_status != 200 or not isinstance(rulesets, list):
        raise ReleaseError(
            f"Could not read repository rulesets (HTTP {listing_status}); refusing Lufa writes."
        )
    if len(rulesets) >= 100:
        raise ReleaseError("Repository ruleset listing may be truncated; refusing Lufa writes.")

    matches = [
        ruleset
        for ruleset in rulesets
        if isinstance(ruleset, dict) and ruleset.get("name") == RELEASE_RULESET_NAME
    ]
    if len(matches) != 1:
        raise ReleaseError(
            f"The required release ruleset {RELEASE_RULESET_NAME!r} was not found uniquely."
        )
    ruleset_id = matches[0].get("id")
    if not isinstance(ruleset_id, int) or ruleset_id <= 0:
        raise ReleaseError("The required release ruleset has malformed identity metadata.")

    detail_status, ruleset = api.request(
        "GET", f"rulesets/{ruleset_id}?includes_parents=true"
    )
    if detail_status != 200 or not isinstance(ruleset, dict):
        raise ReleaseError(
            f"Could not read release ruleset details (HTTP {detail_status}); refusing Lufa writes."
        )
    if (
        ruleset.get("id") != ruleset_id
        or ruleset.get("name") != RELEASE_RULESET_NAME
        or ruleset.get("source_type") != "Repository"
    ):
        raise ReleaseError("The required release ruleset is not repository-scoped.")
    if ruleset.get("enforcement") != "active":
        raise ReleaseError("The release branch ruleset is not active.")
    if ruleset.get("target") != "branch":
        raise ReleaseError("The release branch ruleset target is not branch.")

    conditions = ruleset.get("conditions")
    if (
        not isinstance(conditions, dict)
        or set(conditions) != {"ref_name"}
        or not isinstance(conditions.get("ref_name"), dict)
        or conditions["ref_name"].get("include") != [RELEASE_BRANCH_REF]
        or conditions["ref_name"].get("exclude") != []
    ):
        raise ReleaseError("The release branch ruleset does not target exactly the managed branch.")

    rules = ruleset.get("rules")
    if not isinstance(rules, list):
        raise ReleaseError("The release branch ruleset does not expose its required rules.")
    found_rules = {
        item.get("type") for item in rules if isinstance(item, dict)
    }
    missing_rules = REQUIRED_RULE_TYPES - found_rules
    if missing_rules:
        raise ReleaseError(
            "The release branch ruleset is missing required rules: "
            + ", ".join(sorted(missing_rules))
            + "."
        )


def authorize_version_branch_update(api, app_slug: str) -> None:
    """Authorize only a clean first run or a verified Lufa-managed branch/PR."""
    if not app_slug or not app_slug.isascii():
        raise ReleaseError("The configured release App slug is unavailable.")

    branch_status, branch_response = api.request(
        "GET", f"git/ref/heads/{VERSION_BRANCH}"
    )
    if branch_status == 404:
        branch_sha = None
    elif branch_status == 200 and isinstance(branch_response, dict):
        ref_object = branch_response.get("object")
        branch_sha = ref_object.get("sha") if isinstance(ref_object, dict) else None
        if not isinstance(branch_sha, str) or not branch_sha:
            raise ReleaseError("The managed version branch has malformed ref metadata.")
    else:
        raise ReleaseError(
            f"Could not inspect the managed version branch (HTTP {branch_status})."
        )

    query = urlencode(
        {
            "state": "all",
            "head": f"grasdouble:{VERSION_BRANCH}",
            "base": "main",
            "per_page": "100",
            "sort": "updated",
            "direction": "desc",
        }
    )
    pulls_status, pulls = api.request("GET", f"pulls?{query}")
    if pulls_status != 200 or not isinstance(pulls, list):
        raise ReleaseError(
            f"Could not inspect managed version PR history (HTTP {pulls_status})."
        )
    if len(pulls) >= 100:
        raise ReleaseError("Managed version PR history is truncated; refusing branch update.")

    if branch_sha is None and not pulls:
        # First use: neither a branch nor any PR history exists to overwrite.
        return
    if not pulls:
        raise ReleaseError("The managed version branch has no matching managed PR.")

    # GitHub sorts this complete (bounded) response by most recently updated.
    pull = pulls[0]
    head = pull.get("head")
    base = pull.get("base")
    author = pull.get("user")
    head_repo = head.get("repo") if isinstance(head, dict) else None
    base_repo = base.get("repo") if isinstance(base, dict) else None
    if (
        not isinstance(head, dict)
        or head.get("ref") != VERSION_BRANCH
        or not isinstance(head_repo, dict)
        or head_repo.get("full_name") != REPOSITORY
        or not isinstance(base, dict)
        or base.get("ref") != "main"
        or not isinstance(base_repo, dict)
        or base_repo.get("full_name") != REPOSITORY
        or not isinstance(author, dict)
        or author.get("login") != f"{app_slug}[bot]"
        or pull.get("title") != VERSION_PR_TITLE
    ):
        raise ReleaseError("The managed version PR is not owned by the configured release App.")

    pull_sha = head.get("sha")
    if not isinstance(pull_sha, str) or not pull_sha:
        raise ReleaseError("The managed version PR has malformed head metadata.")
    if branch_sha is not None and branch_sha != pull_sha:
        raise ReleaseError("The managed version branch does not match the PR head SHA.")
    if branch_sha is None and pull.get("state") == "open":
        raise ReleaseError("The open managed version PR has no matching branch.")

    commit_status, commit_response = api.request("GET", f"commits/{pull_sha}")
    commit = commit_response.get("commit") if isinstance(commit_response, dict) else None
    commit_author = commit_response.get("author") if isinstance(commit_response, dict) else None
    commit_committer = commit_response.get("committer") if isinstance(commit_response, dict) else None
    if (
        commit_status != 200
        or not isinstance(commit, dict)
        or not isinstance(commit_author, dict)
        or commit_author.get("login") != f"{app_slug}[bot]"
        or not isinstance(commit_committer, dict)
        or commit_committer.get("login") not in {f"{app_slug}[bot]", "web-flow"}
        or not isinstance(commit.get("message"), str)
        or commit["message"].splitlines()[0] != VERSION_PR_TITLE
    ):
        raise ReleaseError("The managed version branch tip is not authored by the configured release App.")

    open_managed_pr = pull.get("state") == "open" and pull.get("merged_at") is None
    confirmed_merged_pr = (
        pull.get("state") == "closed"
        and isinstance(pull.get("merged_at"), str)
        and bool(pull.get("merged_at"))
    )
    if not (open_managed_pr or confirmed_merged_pr):
        raise ReleaseError("The managed version PR is not open or confirmed merged.")


def main() -> int:
    try:
        api = GitHubReleaseClient(os.environ.get("GH_TOKEN", ""))
        verify_release_branch_ruleset(api)
        authorize_version_branch_update(
            api, os.environ.get("PACKAGE_RELEASE_APP_SLUG", "")
        )
    except (OSError, ReleaseError, ValueError) as error:
        print(f"Managed version branch authorization failed closed: {error}", file=sys.stderr)
        return 1
    print("Managed version branch and PR state is authorized for the Lufa action.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
