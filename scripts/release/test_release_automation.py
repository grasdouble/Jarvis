"""Acceptance tests for the Changesets package release workflow."""

import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import yaml

from create_version_pr import authorize_branch_update
from release_common import (
    GitHubReleaseClient,
    PackageRelease,
    ReleaseError,
    github_app_environment,
    publish_release,
)
from publish_releases import changelog_section, verify_merged_version_pr


ROOT = Path(__file__).resolve().parents[2]


class ReleaseAutomationContractTests(unittest.TestCase):
    def test_version_pr_and_post_merge_release_workflows_exist_separately(self) -> None:
        self.assertTrue((ROOT / ".github/workflows/package-version-pr.yml").is_file())
        self.assertTrue((ROOT / ".github/workflows/package-releases.yml").is_file())

    def test_workflow_writes_are_scoped_and_actions_are_sha_pinned(self) -> None:
        for relative in (
            ".github/workflows/package-version-pr.yml",
            ".github/workflows/package-releases.yml",
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

    def test_release_workflow_only_handles_a_merged_changesets_version_pr(self) -> None:
        document = yaml.load(
            (ROOT / ".github/workflows/package-releases.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        self.assertEqual(["closed"], document["on"]["pull_request"]["types"])
        release_job = document["jobs"]["release"]
        condition = release_job["if"]
        self.assertIn("pull_request.merged", condition)
        self.assertIn("changesets/version", condition)
        self.assertIn("base.ref == 'main'", condition)
        self.assertIn("head.repo.full_name == 'grasdouble/Jarvis'", condition)
        self.assertEqual(
            {"contents": "write", "pull-requests": "read"}, release_job["permissions"]
        )

    def test_release_and_version_pr_logic_are_local_reviewed_scripts(self) -> None:
        self.assertTrue((ROOT / "scripts/release/create_version_pr.py").is_file())
        self.assertTrue((ROOT / "scripts/release/publish_releases.py").is_file())
        version_script = (ROOT / "scripts/release/create_version_pr.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("--force", version_script)

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

    def test_release_notes_are_scoped_to_the_exact_changelog_version(self) -> None:
        changelog = "## 0.0.2\n\nSecond patch.\n\n## 0.0.1\n\nFirst patch.\n"
        self.assertEqual("Second patch.", changelog_section(changelog, "0.0.2"))
        self.assertEqual("First patch.", changelog_section(changelog, "0.0.1"))
        with self.assertRaisesRegex(ReleaseError, "missing the exact version heading"):
            changelog_section(changelog, "0.0.3")

    def test_release_requires_the_configured_app_merged_same_repo_version_pr(self) -> None:
        client = FakePullClient(valid_pull_request())
        verify_merged_version_pr(client, 42, "a" * 40, "package-release-app")

        client.pull["user"]["login"] = "human-user"
        with self.assertRaisesRegex(ReleaseError, "not the configured App"):
            verify_merged_version_pr(client, 42, "a" * 40, "package-release-app")

    def test_release_rerun_reconciles_an_existing_correct_tag(self) -> None:
        client = FakeReleaseClient()
        release = artifact("@fixture/api", "0.0.1")
        client.tags[release.tag] = "a" * 40

        publish_release(client, release, "a" * 40)
        publish_release(client, release, "a" * 40)

        self.assertEqual(0, client.tag_create_count)
        self.assertEqual(1, client.release_create_count)
        self.assertEqual("a" * 40, client.tags[release.tag])
        self.assertEqual("main", client.releases[release.tag]["target_commitish"])

    def test_conflicting_existing_tag_is_rejected_without_retagging(self) -> None:
        client = FakeReleaseClient()
        release = artifact("@fixture/api", "0.0.1")
        client.tags[release.tag] = "b" * 40

        with self.assertRaisesRegex(ReleaseError, "not the verified release commit"):
            publish_release(client, release, "a" * 40)

        self.assertEqual(0, client.tag_create_count)
        self.assertEqual({}, client.releases)

    def test_interruption_after_tag_creation_resumes_release_creation(self) -> None:
        client = FakeReleaseClient(fail_after_tag_once=True)
        release = artifact("@fixture/api", "0.0.1")

        with self.assertRaisesRegex(ReleaseError, "interrupted after tag"):
            publish_release(client, release, "a" * 40)
        publish_release(client, release, "a" * 40)

        self.assertEqual("a" * 40, client.tags[release.tag])
        self.assertEqual(1, client.release_create_count)
        self.assertIn(release.tag, client.releases)

    def test_existing_release_with_different_notes_is_rejected(self) -> None:
        client = FakeReleaseClient()
        release = artifact("@fixture/api", "0.0.1")
        client.tags[release.tag] = "a" * 40
        client.releases[release.tag] = client.release_payload(release)
        client.releases[release.tag]["body"] = "unexpected notes"

        with self.assertRaisesRegex(ReleaseError, "conflicts in fields: body"):
            publish_release(client, release, "a" * 40)

    def test_verified_tag_is_authoritative_when_release_reports_default_branch(self) -> None:
        client = FakeReleaseClient()
        release = artifact("@fixture/api", "0.0.1")
        client.tags[release.tag] = "a" * 40
        client.releases[release.tag] = client.release_payload(release)
        client.releases[release.tag]["target_commitish"] = "main"

        publish_release(client, release, "a" * 40)

        self.assertEqual("a" * 40, client.tags[release.tag])
        self.assertEqual(0, client.release_create_count)

    def test_existing_release_without_its_tag_is_not_repaired_implicitly(self) -> None:
        client = FakeReleaseClient()
        release = artifact("@fixture/api", "0.0.1")
        client.releases[release.tag] = client.release_payload(release)

        with self.assertRaisesRegex(ReleaseError, "exists without its immutable Git tag"):
            publish_release(client, release, "a" * 40)

        self.assertEqual({}, client.tags)

    def test_version_branch_updates_require_an_app_owned_open_or_merged_pr(self) -> None:
        open_pull = version_pull(state="open", merged=False)
        authorize_branch_update(open_pull, None, "b" * 40, "a" * 40, "package-release-app")
        authorize_branch_update(
            None,
            version_pull(state="closed", merged=True),
            "b" * 40,
            "a" * 40,
            "package-release-app",
        )
        authorize_branch_update(None, None, "a" * 40, "a" * 40, "package-release-app")

        with self.assertRaisesRegex(ReleaseError, "not owned by the configured"):
            authorize_branch_update(
                version_pull(state="open", merged=False, author="human"),
                None,
                "b" * 40,
                "a" * 40,
                "package-release-app",
            )
        with self.assertRaisesRegex(ReleaseError, "will not be reopened"):
            authorize_branch_update(
                None,
                version_pull(state="closed", merged=False),
                "b" * 40,
                "a" * 40,
                "package-release-app",
            )
        with self.assertRaisesRegex(ReleaseError, "refusing to overwrite"):
            authorize_branch_update(None, None, "b" * 40, "a" * 40, "package-release-app")

    def test_merged_list_response_authorizes_reserved_branch_update(self) -> None:
        # GitHub's list-pulls endpoint reports `merged: null` even for a merged
        # PR; `merged_at` is the list response's merge evidence.
        merged_list_response = version_pull(state="closed", merged=None)
        merged_list_response["merged_at"] = "2026-10-20T15:29:15Z"

        authorize_branch_update(
            None, merged_list_response, "b" * 40, "a" * 40, "package-release-app"
        )

        closed_unmerged_list_response = version_pull(state="closed", merged=None)
        closed_unmerged_list_response["merged_at"] = None
        with self.assertRaisesRegex(ReleaseError, "will not be reopened"):
            authorize_branch_update(
                None,
                closed_unmerged_list_response,
                "b" * 40,
                "a" * 40,
                "package-release-app",
            )


def artifact(package: str, version: str) -> PackageRelease:
    return PackageRelease(
        package,
        version,
        f"{package}@{version}",
        f"Release notes for {version}.",
    )


class FakeReleaseClient:
    def __init__(self, *, fail_after_tag_once: bool = False) -> None:
        self.tags: dict[str, str] = {}
        self.releases: dict[str, dict] = {}
        self.tag_create_count = 0
        self.release_create_count = 0
        self.fail_after_tag_once = fail_after_tag_once

    def tag_commit(self, tag: str) -> str | None:
        return self.tags.get(tag)

    def create_tag(self, tag: str, commit_sha: str, message: str) -> None:
        self.tag_create_count += 1
        self.tags[tag] = commit_sha
        if self.fail_after_tag_once:
            self.fail_after_tag_once = False
            raise ReleaseError("interrupted after tag reference creation")

    def release(self, tag: str) -> dict | None:
        return self.releases.get(tag)

    def create_release(self, tag: str, name: str, body: str) -> dict:
        self.release_create_count += 1
        result = {
            "tag_name": tag,
            "target_commitish": "main",
            "name": name,
            "body": body,
            "draft": False,
            "prerelease": False,
        }
        self.releases[tag] = result
        return result

    @staticmethod
    def release_payload(release: PackageRelease) -> dict:
        return {
            "tag_name": release.tag,
            "target_commitish": "main",
            "name": f"{release.package}@{release.version}",
            "body": release.notes,
            "draft": False,
            "prerelease": False,
        }


class FakePullClient:
    def __init__(self, pull: dict) -> None:
        self.pull = pull

    def request(
        self, method: str, endpoint: str, payload: dict | None = None
    ) -> tuple[int, object]:
        if method == "GET" and endpoint == "pulls/42":
            return 200, self.pull
        return 404, None


def valid_pull_request() -> dict:
    return {
        "state": "closed",
        "merged": True,
        "merge_commit_sha": "a" * 40,
        "user": {"login": "package-release-app[bot]"},
        "head": {
            "ref": "changesets/version",
            "repo": {"full_name": "grasdouble/Jarvis"},
        },
        "base": {"ref": "main", "repo": {"full_name": "grasdouble/Jarvis"}},
    }


def version_pull(*, state: str, merged: bool, author: str = "package-release-app[bot]") -> dict:
    pull = valid_pull_request()
    pull["state"] = state
    pull["merged"] = merged
    pull["user"]["login"] = author
    return pull


if __name__ == "__main__":
    unittest.main()
