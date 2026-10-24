"""Exercise the Changesets PR gate against the pinned CLI's generated version output."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

from check_changeset_package_scope import changed_paths, workspace_packages
from check_changeset_pr import is_changesets_version_pr


REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION_PR_GATE = REPO_ROOT / "scripts/ci/check_changeset_pr.py"
PACKAGE_SCOPE_GATE = REPO_ROOT / "scripts/ci/check_changeset_package_scope.py"
sys.path.insert(0, str(REPO_ROOT / "scripts/release"))
from publish_releases import release_plan  # noqa: E402
from release_common import PackageRelease, ReleaseError, publish_release  # noqa: E402


def run(command: list[str], cwd: Path, expect_success: bool) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if (result.returncode == 0) != expect_success:
        raise AssertionError(
            f"Unexpected exit {result.returncode} for {command}:\n{result.stdout}\n{result.stderr}"
        )
    return result


def exercise() -> None:
    with tempfile.TemporaryDirectory(prefix="changeset-version-pr-") as temporary:
        root = Path(temporary)
        (root / ".changeset").mkdir()
        (root / "packages/api").mkdir(parents=True)
        (root / "packages/client").mkdir(parents=True)
        (root / "packages/independent").mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps(
                {
                    "name": "version-pr-fixture",
                    "private": True,
                    "version": "1.0.0",
                    "scripts": {"changeset": "changeset"},
                    "devDependencies": {"@changesets/cli": "3.0.3"},
                }
            ),
            encoding="utf-8",
        )
        (root / ".gitignore").write_text("node_modules\n", encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages:\n  - packages/*\n", encoding="utf-8")
        (root / ".changeset/config.json").write_text(
            (REPO_ROOT / ".changeset/config.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (root / "packages/api/package.json").write_text(
            json.dumps({"name": "@fixture/api", "private": True, "version": "0.0.0"}),
            encoding="utf-8",
        )
        (root / "packages/client/package.json").write_text(
            json.dumps(
                {
                    "name": "@fixture/client",
                    "private": True,
                    "version": "0.0.0",
                    "dependencies": {"@fixture/api": "workspace:^0.0.0"},
                }
            ),
            encoding="utf-8",
        )
        (root / "packages/independent/package.json").write_text(
            json.dumps(
                {"name": "@fixture/independent", "private": True, "version": "0.0.0"}
            ),
            encoding="utf-8",
        )
        (root / ".changeset/release.md").write_text(
            "---\n'@fixture/api': patch\n---\nRelease fixture.\n", encoding="utf-8"
        )
        for name in ("empty-one.md", "empty-two.md"):
            (root / ".changeset" / name).write_text(
                "---\n---\nNo package release.\n", encoding="utf-8"
            )
        # Keep all package installation state inside the disposable fixture. A symlink
        # to the repository's node_modules is unsafe: PNPM manages this path itself.
        run(["pnpm", "install"], root, expect_success=True)

        def git(*args: str) -> str:
            return subprocess.run(
                ["git", *args], cwd=root, check=True, capture_output=True, text=True
            ).stdout

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Changesets version PR test")
        git("config", "user.email", "changesets-version-pr@example.invalid")
        git(
            "add",
            ".gitignore",
            "package.json",
            "pnpm-workspace.yaml",
            "pnpm-lock.yaml",
            ".changeset",
            "packages",
        )
        git("commit", "--quiet", "-m", "base with pending Changeset")
        base_sha = git("rev-parse", "HEAD").strip()
        git("switch", "--quiet", "--create", "version-pr")

        run(["pnpm", "changeset", "version"], root, expect_success=True)
        package = json.loads((root / "packages/api/package.json").read_text(encoding="utf-8"))
        if (
            package.get("version") != "0.0.1"
            or not (root / "packages/api/CHANGELOG.md").is_file()
        ):
            raise AssertionError(
                "Pinned Changesets version command did not produce the expected version PR files"
            )
        client = json.loads((root / "packages/client/package.json").read_text(encoding="utf-8"))
        if client.get("dependencies", {}).get("@fixture/api") != "workspace:^0.0.1":
            raise AssertionError(
                "Changesets version command did not update the internal workspace range"
            )
        run(["pnpm", "install", "--offline", "--lockfile-only"], root, expect_success=True)
        working_gate = run(
            [sys.executable, str(VERSION_PR_GATE), "--working-tree-generated-candidate", base_sha],
            root,
            expect_success=True,
        )
        if "working-tree candidate validated" not in working_gate.stdout:
            raise AssertionError("Dirty Changesets version output was not validated")
        (root / "unexpected.txt").write_text("unrelated candidate mutation\n", encoding="utf-8")
        run(
            [sys.executable, str(VERSION_PR_GATE), "--working-tree-generated-candidate", base_sha],
            root,
            expect_success=False,
        )
        git("add", "unexpected.txt")
        run(
            [sys.executable, str(VERSION_PR_GATE), "--working-tree-generated-candidate", base_sha],
            root,
            expect_success=False,
        )
        git("reset", "--quiet", "--", "unexpected.txt")
        (root / "unexpected.txt").unlink()
        git("add", "-A")
        git("commit", "--quiet", "-m", "generated Changesets version PR")

        run(
            ["pnpm", "install", "--offline", "--frozen-lockfile", "--lockfile-only"],
            root,
            expect_success=True,
        )

        raw_status = run(
            ["pnpm", "changeset", "status", f"--since={base_sha}"], root, expect_success=False
        )
        scope_result = run(
            [sys.executable, str(PACKAGE_SCOPE_GATE), base_sha], root, expect_success=False
        )
        if not is_changesets_version_pr(base_sha, root):
            raise AssertionError(
                f"Version PR not recognized: changes={changed_paths(base_sha, root)!r}; "
                f"base_packages={workspace_packages(root, base_sha)!r}; "
                f"head_packages={workspace_packages(root, 'HEAD')!r}"
            )
        gate_result = run(
            [sys.executable, str(VERSION_PR_GATE), base_sha], root, expect_success=True
        )
        if "no changesets were found" not in (raw_status.stdout + raw_status.stderr).lower():
            raise AssertionError("The fixture did not reproduce the ordinary status-check failure")
        if "changeset" not in (scope_result.stdout + scope_result.stderr).lower():
            raise AssertionError("The fixture did not reproduce the ordinary target-check failure")
        if "Generated Changesets version PR detected" not in gate_result.stdout:
            raise AssertionError("The unified PR gate did not recognize the generated version PR")

        # Simulate the confirmed merge commit and exercise package-level output with no registry.
        version_pr_sha = git("rev-parse", "HEAD").strip()
        git("switch", "--quiet", "main")
        git("merge", "--quiet", "--no-ff", "--no-edit", "version-pr")
        first_merge_sha = git("rev-parse", "HEAD").strip()
        first_releases = release_plan(base_sha, first_merge_sha, root)
        first_tags = {release.tag for release in first_releases}
        if "@fixture/api@0.0.1" not in first_tags:
            raise AssertionError(f"First patch release is missing: {first_tags!r}")
        if "@fixture/independent@0.0.1" in first_tags:
            raise AssertionError("An untouched independent package was incorrectly released")
        first_client_manifest = json.loads(
            (root / "packages/client/package.json").read_text(encoding="utf-8")
        )
        first_client_version = first_client_manifest.get("version")
        if (
            first_client_version != "0.0.0"
            and f"@fixture/client@{first_client_version}" not in first_tags
        ):
            raise AssertionError(
                "A Changesets-propagated dependent version is missing its release tag"
            )
        first_api = next(
            release for release in first_releases if release.tag == "@fixture/api@0.0.1"
        )
        if "Release fixture." not in first_api.notes:
            raise AssertionError(
                "The first GitHub Release notes were not extracted from CHANGELOG.md"
            )

        class FixtureReleaseClient:
            def __init__(self) -> None:
                self.tags: dict[str, str] = {}
                self.releases: dict[str, dict] = {}
                self.registry_uploads = 0

            def tag_commit(self, tag: str) -> str | None:
                return self.tags.get(tag)

            def create_tag(self, tag: str, commit_sha: str, message: str) -> None:
                if tag in self.tags:
                    raise ReleaseError("fixture tag already exists")
                self.tags[tag] = commit_sha

            def release(self, tag: str) -> dict | None:
                return self.releases.get(tag)

            def create_release(
                self, tag: str, name: str, body: str
            ) -> dict:
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

        release_client = FixtureReleaseClient()
        for release in first_releases:
            publish_release(release_client, release, first_merge_sha)
        for release in first_releases:
            publish_release(release_client, release, first_merge_sha)
        if release_client.registry_uploads or set(release_client.tags) != first_tags:
            raise AssertionError("The first rehearsal did not stay registry-free and idempotent")

        # Release another patch of api and a first patch of an independent package.
        (root / ".changeset/api-second.md").write_text(
            "---\n'@fixture/api': patch\n---\nSecond API patch.\n", encoding="utf-8"
        )
        (root / ".changeset/independent-first.md").write_text(
            "---\n'@fixture/independent': patch\n---\nIndependent first patch.\n",
            encoding="utf-8",
        )
        git("add", ".changeset")
        git("commit", "--quiet", "-m", "add second release intent")
        second_base_sha = git("rev-parse", "HEAD").strip()
        git("switch", "--quiet", "--create", "version-pr-two")
        run(["pnpm", "changeset", "version"], root, expect_success=True)
        second_api_manifest = json.loads(
            (root / "packages/api/package.json").read_text(encoding="utf-8")
        )
        independent_manifest = json.loads(
            (root / "packages/independent/package.json").read_text(encoding="utf-8")
        )
        if second_api_manifest.get("version") != "0.0.2":
            raise AssertionError("The second API patch did not increment independently to 0.0.2")
        if independent_manifest.get("version") != "0.0.1":
            raise AssertionError("The independently released package did not start at 0.0.1")
        run(["pnpm", "install", "--offline", "--lockfile-only"], root, expect_success=True)
        git("add", "-A")
        git("commit", "--quiet", "-m", "generated second Changesets version PR")
        run(
            ["pnpm", "install", "--offline", "--frozen-lockfile", "--lockfile-only"],
            root,
            expect_success=True,
        )
        if not is_changesets_version_pr(second_base_sha, root):
            raise AssertionError(
                "The second generated version PR was not accepted by the strict gate"
            )
        second_gate = run(
            [sys.executable, str(VERSION_PR_GATE), second_base_sha], root, expect_success=True
        )
        if "Generated Changesets version PR detected" not in second_gate.stdout:
            raise AssertionError("The second generated version PR did not pass its unified gate")
        second_tree = git("rev-parse", "HEAD^{tree}").strip()
        updated_pr_sha = git(
            "commit-tree",
            second_tree,
            "-p",
            second_base_sha,
            "-p",
            version_pr_sha,
            "-m",
            "build(release): update package versions",
        ).strip()
        git("switch", "--quiet", "--detach", updated_pr_sha)
        if not is_changesets_version_pr(second_base_sha, root):
            raise AssertionError(
                "The fast-forward version-PR update was not recognized by the strict gate"
            )
        updated_gate = run(
            [sys.executable, str(VERSION_PR_GATE), second_base_sha], root, expect_success=True
        )
        if "Generated Changesets version PR detected" not in updated_gate.stdout:
            raise AssertionError(
                "The fast-forward version-PR update did not pass its unified gate"
            )
        git("switch", "--quiet", "main")
        git("merge", "--quiet", "--no-ff", "--no-edit", updated_pr_sha)
        second_merge_sha = git("rev-parse", "HEAD").strip()
        second_releases = release_plan(second_base_sha, second_merge_sha, root)
        second_tags = {release.tag for release in second_releases}
        if not {"@fixture/api@0.0.2", "@fixture/independent@0.0.1"} <= second_tags:
            raise AssertionError(
                f"Second independent package release plan is incomplete: {second_tags!r}"
            )
        for release in second_releases:
            publish_release(release_client, release, second_merge_sha)
        if release_client.registry_uploads:
            raise AssertionError("The rehearsal attempted a package registry upload")

        # A source or unrelated lockfile edit must not qualify as a generated version PR.
        git("switch", "--quiet", "--create", "malformed-version-pr", version_pr_sha)
        lockfile = root / "pnpm-lock.yaml"
        lock_documents = list(yaml.safe_load_all(lockfile.read_text(encoding="utf-8")))
        lock_documents[-1].setdefault("packages", {})["evil@9.9.9"] = {
            "resolution": {"integrity": "sha512-unrelated-lockfile-entry"}
        }
        lockfile.write_text(yaml.safe_dump_all(lock_documents, sort_keys=False), encoding="utf-8")
        git("add", "pnpm-lock.yaml")
        git("commit", "--quiet", "-m", "unrelated lockfile entry")
        if is_changesets_version_pr(base_sha, root):
            raise AssertionError(
                "The generated-version exception accepted an unrelated lockfile entry"
            )
        print(
            "Generated version PRs and fast-forward updates are recognized; "
            "0.0.1 then 0.0.2 package tags/releases "
            "remain independent and registry-free; unrelated lockfile content is rejected."
        )


if __name__ == "__main__":
    exercise()
