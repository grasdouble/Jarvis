"""Acceptance tests for the Changesets package release workflow."""

import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import yaml

from authorize_version_branch import (
    authorize_version_branch_update,
    verify_release_branch_ruleset,
)
from run_changeset_version import run as run_changeset_version
from release_common import (
    GitHubReleaseClient,
    ReleaseError,
    github_app_environment,
)
ROOT = Path(__file__).resolve().parents[2]


class ReleaseAutomationContractTests(unittest.TestCase):
    def test_version_pr_and_post_merge_release_workflows_exist_separately(self) -> None:
        self.assertTrue((ROOT / ".github/workflows/package-version-pr.yml").is_file())
        self.assertTrue((ROOT / ".github/workflows/changeset-releases.yml").is_file())

    def test_workflow_writes_are_scoped_and_actions_are_sha_pinned(self) -> None:
        for relative in (
            ".github/workflows/package-version-pr.yml",
            ".github/workflows/changeset-releases.yml",
        ):
            with self.subTest(workflow=relative):
                text = (ROOT / relative).read_text(encoding="utf-8")
                document = yaml.load(text, Loader=yaml.BaseLoader)
                self.assertEqual({"contents": "read"}, document["permissions"])
                self.assertRegex(text, r"(?m)^\s{4}permissions:\s*$")
                self.assertIn("contents: write", text)
                self.assertIn("actions/create-github-app-token@", text)
                self.assertIn("repositories: Jarvis", text)
                self.assertIn("owner: grasdouble", text)
                self.assertNotIn("pull_request_target", text)
                self.assertNotIn("permission-administration:", text)
                self.assertNotIn("permission-workflows:", text)
                for action in re.findall(r"(?m)^\s*- uses: ([^\s]+)", text):
                    self.assertRegex(action, r"@[0-9a-f]{40}$", action)

    def test_version_pr_workflow_needs_pending_changesets_and_trusted_main(self) -> None:
        document = yaml.load(
            (ROOT / ".github/workflows/package-version-pr.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        self.assertEqual(["main"], document["on"]["push"]["branches"])
        self.assertIn("workflow_dispatch", document["on"])
        self.assertEqual({"contents": "read"}, document["jobs"]["detect"]["permissions"])
        self.assertEqual(
            "needs.detect.outputs.pending == 'true'",
            document["jobs"]["version-pr"]["if"],
        )
        version_pr = document["jobs"]["version-pr"]
        steps = version_pr["steps"]
        preflight = next(step for step in steps if step.get("name") == "Verify trusted event and exact checkout revision")
        app_token = next(i for i, step in enumerate(steps) if step.get("id") == "app")
        identity_index = next(
            i
            for i, step in enumerate(steps)
            if step.get("name") == "Verify the installed package-release App identity"
        )
        action_index = next(i for i, step in enumerate(steps) if "changesets-release" in step.get("uses", ""))
        preflight_index = steps.index(preflight)
        self.assertLess(preflight_index, app_token)
        self.assertLess(preflight_index, action_index)
        self.assertIn("refs/heads/main", preflight["run"])
        self.assertIn("git rev-parse HEAD", preflight["run"])
        self.assertIn("$CHECKOUT_SHA\" = \"$EVENT_SHA", preflight["run"])
        self.assertEqual({"EVENT_REF": "${{ github.ref }}", "EVENT_SHA": "${{ github.sha }}"}, preflight["env"])
        branch_authorizer = next(
            step
            for step in steps
            if step.get("name") == "Verify release ruleset and authorize managed Changesets branch before Lufa writes"
        )
        authorizer_index = steps.index(branch_authorizer)
        self.assertLess(app_token, authorizer_index)
        self.assertLess(identity_index, authorizer_index)
        self.assertLess(authorizer_index, action_index)
        self.assertEqual(
            {
                "GH_TOKEN": "${{ steps.app.outputs.token }}",
                "PACKAGE_RELEASE_APP_SLUG": "${{ vars.PACKAGE_RELEASE_APP_SLUG }}",
            },
            branch_authorizer["env"],
        )
        self.assertEqual("python3 scripts/release/authorize_version_branch.py", branch_authorizer["run"])
        action_steps = [step for step in version_pr["steps"] if "uses" in step and "changesets-release" in step["uses"]]
        self.assertEqual(1, len(action_steps))
        action_step = action_steps[0]
        self.assertRegex(action_step["uses"], r"@([0-9a-f]{40})$")
        self.assertEqual("", action_step["with"]["publish-command"])
        self.assertEqual("false", action_step["with"]["create-github-releases"])
        self.assertIn("run_changeset_version.py", action_step["with"]["version-command"])
        self.assertIn("release-token", action_step["with"])
        self.assertNotIn("packages", version_pr["permissions"])

    def test_release_workflow_keeps_event_filters_checkout_and_app_identity(self) -> None:
        document = yaml.load(
            (ROOT / ".github/workflows/changeset-releases.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        event = document["on"]["pull_request"]
        self.assertEqual(["main"], event["branches"])
        self.assertEqual(["closed"], event["types"])
        release_job = document["jobs"]["release"]
        condition = release_job["if"]
        self.assertIn("pull_request.merged", condition)
        self.assertIn("changesets/version", condition)
        self.assertIn("changeset-release/main", condition)
        self.assertIn("base.ref == 'main'", condition)
        self.assertIn("head.repo.full_name == 'grasdouble/Jarvis'", condition)
        self.assertEqual({"contents": "write"}, release_job["permissions"])
        steps = release_job["steps"]
        app_token = next(step for step in steps if step.get("id") == "app")
        self.assertNotIn("permission-pull-requests", app_token["with"])
        checkout = next(step for step in steps if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(
            "${{ github.event.pull_request.merge_commit_sha }}",
            checkout["with"]["ref"],
        )
        self.assertNotIn(
            "Validate merged version PR and generated diff",
            [step.get("name") for step in steps],
        )
        self.assertFalse((ROOT / "scripts/release/publish_releases.py").exists())
        self.assertFalse(any("pip install" in step.get("run", "") for step in steps))
        self.assertNotIn("GITHUB_SHA", repr(steps))
        self.assertNotIn("MERGE_COMMIT_SHA", repr(steps))
        identity = next(
            step
            for step in steps
            if step.get("name") == "Verify the installed package-release App identity"
        )
        self.assertEqual(
            {
                "EXPECTED_SLUG": "${{ vars.PACKAGE_RELEASE_APP_SLUG }}",
                "EXPECTED_INSTALLATION_ID": "${{ vars.PACKAGE_RELEASE_APP_INSTALLATION_ID }}",
                "ACTUAL_SLUG": "${{ steps.app.outputs.app-slug }}",
                "ACTUAL_INSTALLATION_ID": "${{ steps.app.outputs.installation-id }}",
            },
            identity["env"],
        )
        self.assertLess(steps.index(identity), next(
            i for i, step in enumerate(steps)
            if "grasdouble/Lufa-CICD/actions/changesets-release@" in step.get("uses", "")
        ))

    def test_post_merge_action_uses_cli_tag_events_without_registry_publish(self) -> None:
        config = yaml.safe_load((ROOT / ".changeset/config.json").read_text())
        self.assertTrue(config["privatePackages"]["tag"])
        document = yaml.load(
            (ROOT / ".github/workflows/changeset-releases.yml").read_text(),
            Loader=yaml.BaseLoader,
        )
        steps = document["jobs"]["release"]["steps"]
        action_index = next(
            i
            for i, step in enumerate(steps)
            if "grasdouble/Lufa-CICD/actions/changesets-release@" in step.get("uses", "")
        )
        action = steps[action_index]
        self.assertEqual(
            "grasdouble/Lufa-CICD/actions/changesets-release@320fce890fbd7bcb347141648174d1c3f7b786ad",
            action["uses"],
        )
        self.assertEqual("${{ steps.app.outputs.token }}", action["with"]["release-token"])
        self.assertIn(
            "python3 scripts/release/tag_private_packages.py --cli node_modules/.bin/changeset",
            action["with"]["publish-command"],
        )
        self.assertEqual("true", action["with"]["create-github-releases"])
        self.assertNotIn("version-command", action["with"])
        self.assertNotIn("github-token", action["with"])
        self.assertNotIn("publish-script", action["with"])
        self.assertFalse(any(
            "changesets/action@" in step.get("uses", "")
            for step in steps
        ))

    def test_pinned_action_retry_limitations_are_documented(self) -> None:
        docs = "\n".join(
            (ROOT / path).read_text(encoding="utf-8")
            for path in (
                "docs/development-workflow.md",
                "docs/package-release-app-setup.md",
            )
        ).lower()
        self.assertIn("tag-push failures can be warnings", docs)
        self.assertIn("release creation continues", docs)
        self.assertIn("can therefore use a pre-existing tag that points elsewhere", docs)
        self.assertIn("no longer explicitly verifies the context sha", docs)
        self.assertIn("no longer calls a post-merge pr identity/generated-diff preflight", docs)
        self.assertIn("post-merge release workflow no longer repeats that generated-diff validation", docs)
        self.assertIn("does not reconcile existing releases", docs)
        self.assertIn("duplicate creation can fail on rerun", docs)
        self.assertIn("leaves them there for the action to read", docs)
        self.assertIn(
            "python3 scripts/release/tag_private_packages.py --cli node_modules/.bin/changeset",
            docs,
        )

    def test_version_generation_uses_validated_runner(self) -> None:
        self.assertTrue((ROOT / "scripts/release/run_changeset_version.py").is_file())

    def test_credentials_and_destinations_are_documented_without_registry_publication(
        self,
    ) -> None:
        readme = (ROOT / ".changeset/README.md").read_text(encoding="utf-8").lower()
        workflow = (ROOT / "docs/development-workflow.md").read_text(encoding="utf-8").lower()
        for phrase in (
            "github releases",
            "package-release",
            "does not publish packages to npm",
            "0.0.1",
            "0.0.2",
        ):
            self.assertIn(phrase, readme + workflow)
        self.assertIn("without fallback", readme + workflow)
        self.assertIn("mac pem", readme + workflow)


class ReleaseBehaviorTests(unittest.TestCase):
    def test_release_branch_ruleset_requires_unique_active_exact_scope_and_rules(self) -> None:
        api = FakeRulesetClient([valid_release_ruleset()])
        verify_release_branch_ruleset(api)

        for label, mutate, expected_error in (
            ("missing", lambda rules: rules.clear(), "not found uniquely"),
            ("disabled", lambda rules: rules[0].update(enforcement="disabled"), "not active"),
            ("wrong target", lambda rules: rules[0]["conditions"]["ref_name"].update(include=["refs/heads/main"]), "does not target exactly"),
            ("missing rule", lambda rules: rules[0]["rules"].pop(), "missing required rules"),
        ):
            with self.subTest(case=label):
                rules = [valid_release_ruleset()]
                mutate(rules)
                with self.assertRaisesRegex(ReleaseError, expected_error):
                    verify_release_branch_ruleset(FakeRulesetClient(rules))

        with self.assertRaisesRegex(ReleaseError, "not found uniquely"):
            verify_release_branch_ruleset(
                FakeRulesetClient([valid_release_ruleset(), valid_release_ruleset()])
            )

    def test_version_branch_authorization_allows_first_run_and_verified_reruns(self) -> None:
        api = FakeVersionBranchClient(branch_sha=None, pulls=[])
        authorize_version_branch_update(api, "package-release-app")

        api.branch_sha = "b" * 40
        api.pulls = [managed_version_pr("b" * 40)]
        authorize_version_branch_update(api, "package-release-app")

        api.pulls[0].update(state="closed", merged=True, merged_at="2026-10-24T00:00:00Z")
        authorize_version_branch_update(api, "package-release-app")

    def test_version_branch_accepts_github_web_flow_committer_for_app_authored_commit(self) -> None:
        """GitHub API evidence: PR + commit author are the App; committer is web-flow."""
        api = FakeVersionBranchClient(branch_sha="b" * 40, pulls=[managed_version_pr("b" * 40)])
        api.commit_author = "package-release-app[bot]"
        api.commit_committer = "web-flow"

        authorize_version_branch_update(api, "package-release-app")

    def test_version_branch_committer_and_commit_author_are_fail_closed(self) -> None:
        for label, committer, author in (
            ("unknown committer", "ordinary-user", "package-release-app[bot]"),
            ("missing committer", None, "package-release-app[bot]"),
            ("missing commit author", "web-flow", None),
            ("non-App commit author", "web-flow", "ordinary-user"),
        ):
            with self.subTest(case=label):
                api = FakeVersionBranchClient(branch_sha="b" * 40, pulls=[managed_version_pr("b" * 40)])
                api.commit_author = author
                api.commit_committer = committer
                with self.assertRaisesRegex(ReleaseError, "not authored by the configured release App"):
                    authorize_version_branch_update(api, "package-release-app")

    def test_version_branch_web_flow_exception_does_not_relax_managed_pr_guards(self) -> None:
        for label, mutate, expected_error in (
            ("PR owner", lambda api: api.pulls[0]["user"].update(login="ordinary-user"), "configured release App"),
            ("PR title", lambda api: api.pulls[0].update(title="unexpected"), "configured release App"),
            ("head SHA", lambda api: api.pulls[0]["head"].update(sha="c" * 40), "does not match the PR head SHA"),
        ):
            with self.subTest(case=label):
                api = FakeVersionBranchClient(branch_sha="b" * 40, pulls=[managed_version_pr("b" * 40)])
                api.commit_committer = "web-flow"
                mutate(api)
                with self.assertRaisesRegex(ReleaseError, expected_error):
                    authorize_version_branch_update(api, "package-release-app")

        api = FakeVersionBranchClient(branch_sha="b" * 40, pulls=[managed_version_pr("b" * 40)])
        api.commit_committer = "web-flow"
        with self.assertRaisesRegex(ReleaseError, "not found uniquely"):
            verify_release_branch_ruleset(FakeRulesetClient([]))

    def test_version_branch_authorization_rejects_preexisting_unverified_state(self) -> None:
        api = FakeVersionBranchClient(branch_sha="b" * 40, pulls=[])
        with self.assertRaisesRegex(ReleaseError, "no matching managed PR"):
            authorize_version_branch_update(api, "package-release-app")

        api.pulls = [managed_version_pr("b" * 40, author="ordinary-user")]
        with self.assertRaisesRegex(ReleaseError, "configured release App"):
            authorize_version_branch_update(api, "package-release-app")

        api.pulls = [managed_version_pr("c" * 40)]
        with self.assertRaisesRegex(ReleaseError, "does not match the PR head"):
            authorize_version_branch_update(api, "package-release-app")

        api.pulls = [managed_version_pr("b" * 40)]
        api.commit_author = "ordinary-user"
        with self.assertRaisesRegex(ReleaseError, "not authored by the configured release App"):
            authorize_version_branch_update(api, "package-release-app")

        api.pulls = [managed_version_pr("b" * 40, state="closed", merged=False)]
        api.commit_author = "package-release-app[bot]"
        with self.assertRaisesRegex(ReleaseError, "not open or confirmed merged"):
            authorize_version_branch_update(api, "package-release-app")

    def test_lufa_version_command_runs_validated_generation_without_write_credentials(self) -> None:
        sha = "a" * 40
        with patch.dict(
            os.environ,
            {
                "GITHUB_SHA": sha,
                "GH_TOKEN": "app-token",
                "GITHUB_TOKEN": "app-token",
                "GH_ENTERPRISE_TOKEN": "other-token",
            },
            clear=True,
        ), patch("run_changeset_version.safe_process") as process:
            run_changeset_version()

        self.assertEqual(3, process.call_count)
        for call in process.call_args_list:
            self.assertNotIn("GH_TOKEN", call.kwargs["env"])
            self.assertNotIn("GITHUB_TOKEN", call.kwargs["env"])
            self.assertNotIn("GH_ENTERPRISE_TOKEN", call.kwargs["env"])
        self.assertEqual(["pnpm", "changeset", "version"], process.call_args_list[0].args[0])
        self.assertEqual(["pnpm", "install", "--lockfile-only"], process.call_args_list[1].args[0])
        self.assertEqual("--working-tree-generated-candidate", process.call_args_list[2].args[0][-2])
        self.assertEqual(sha, process.call_args_list[2].args[0][-1])

    def test_lufa_version_command_rejects_missing_base_revision(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ReleaseError, "GITHUB_SHA"):
                run_changeset_version()

    def test_git_environment_replaces_personal_credentials_with_the_supplied_app_token(
        self,
    ) -> None:
        with patch.dict(
            os.environ,
            {"GITHUB_TOKEN": "personal-token", "GH_ENTERPRISE_TOKEN": "other-token"},
        ):
            with github_app_environment("installation-token") as environment:
                self.assertEqual("installation-token", environment["GH_TOKEN"])
                self.assertNotIn("GITHUB_TOKEN", environment)
                self.assertNotIn("GH_ENTERPRISE_TOKEN", environment)
                self.assertTrue(Path(environment["GIT_ASKPASS"]).is_file())
                self.assertEqual("/dev/null", environment["GIT_CONFIG_GLOBAL"])

    def test_github_api_requests_are_fixed_to_the_repo_and_keep_tokens_out_of_urls(self) -> None:
        client = GitHubReleaseClient("synthetic-installation-token")

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args) -> None:
                return None

            def read(self) -> bytes:
                return b'{"ok":true}'

        class Opener:
            request = None

            def open(self, request, timeout: int):
                self.request = request
                return Response()

        opener = Opener()
        client._opener = opener
        status, response = client.request("GET", "pulls?state=open")

        self.assertEqual(200, status)
        self.assertEqual({"ok": True}, response)
        self.assertEqual(
            "Bearer synthetic-installation-token",
            opener.request.get_header("Authorization"),
        )
        self.assertEqual(
            "https://api.github.com/repos/grasdouble/Jarvis/pulls?state=open",
            opener.request.full_url,
        )

    def test_github_api_rejects_endpoint_escape_and_missing_token(self) -> None:
        client = GitHubReleaseClient("synthetic-installation-token")
        with self.assertRaisesRegex(ReleaseError, "invalid GitHub API endpoint"):
            client.request("GET", "../other/repository")
        with self.assertRaisesRegex(ReleaseError, "token is unavailable"):
            GitHubReleaseClient("")

class FakeVersionBranchClient:
    def __init__(self, *, branch_sha: str | None, pulls: list[dict]) -> None:
        self.branch_sha = branch_sha
        self.pulls = pulls
        self.commit_author: str | None = "package-release-app[bot]"
        self.commit_committer: str | None = "package-release-app[bot]"
        self.requests: list[tuple[str, str]] = []

    def request(self, method: str, endpoint: str, payload: dict | None = None):
        self.requests.append((method, endpoint))
        if method != "GET" or payload is not None:
            raise AssertionError("authorization preflight must be read-only")
        if endpoint == "git/ref/heads/changeset-release/main":
            if self.branch_sha is None:
                return 404, None
            return 200, {"object": {"sha": self.branch_sha}}
        if endpoint.startswith("pulls?"):
            return 200, self.pulls
        if endpoint.startswith("commits/"):
            return 200, {
                "author": {"login": self.commit_author} if self.commit_author is not None else None,
                "committer": {"login": self.commit_committer} if self.commit_committer is not None else None,
                "commit": {"message": "build(release): update package versions"},
            }
        raise AssertionError(f"unexpected API request: {endpoint}")


class FakeRulesetClient:
    def __init__(self, rulesets: list[dict]) -> None:
        self.rulesets = rulesets
        self.requests: list[tuple[str, str]] = []

    def request(self, method: str, endpoint: str, payload: dict | None = None):
        self.requests.append((method, endpoint))
        if method != "GET" or payload is not None:
            raise AssertionError("ruleset preflight must be read-only")
        if endpoint.startswith("rulesets?"):
            return 200, [{"id": item["id"], "name": item["name"]} for item in self.rulesets]
        if endpoint == "rulesets/25784220?includes_parents=true":
            if not self.rulesets:
                return 404, None
            return 200, self.rulesets[0]
        raise AssertionError(f"unexpected API request: {endpoint}")


def valid_release_ruleset() -> dict:
    return {
        "id": 25784220,
        "name": "Changesets release branch — package release App",
        "target": "branch",
        "source_type": "Repository",
        "source": "grasdouble/Jarvis",
        "enforcement": "active",
        "conditions": {
            "ref_name": {
                "include": ["refs/heads/changeset-release/main"],
                "exclude": [],
            }
        },
        "rules": [
            {"type": rule_type}
            for rule_type in ("creation", "update", "deletion", "non_fast_forward")
        ],
    }


def managed_version_pr(
    head_sha: str,
    *,
    author: str = "package-release-app[bot]",
    state: str = "open",
    merged: bool = False,
) -> dict:
    return {
        "state": state,
        "merged": merged,
        "merged_at": None,
        "title": "build(release): update package versions",
        "user": {"login": author},
        "head": {
            "ref": "changeset-release/main",
            "sha": head_sha,
            "repo": {"full_name": "grasdouble/Jarvis"},
        },
        "base": {"ref": "main", "repo": {"full_name": "grasdouble/Jarvis"}},
    }


if __name__ == "__main__":
    unittest.main()
