"""Exercise generated Changesets PR validation and private-only default publishing."""

from __future__ import annotations

import json
import os
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
PREPARE_PRIVATE_RELEASE_NOTES = REPO_ROOT / "scripts/release/prepare_private_release_notes.py"
PINNED_CHANGESET_VERSION = "3.0.3"


def changeset_cli() -> Path:
    configured = os.environ.get("JARVIS_CHANGESET_CLI")
    cli = Path(configured).expanduser() if configured else REPO_ROOT / "node_modules/.bin/changeset"
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise RuntimeError(f"Changesets CLI is not an executable file: {cli}")
    absolute_cli = cli.absolute()
    if absolute_cli.parent.name != ".bin" or absolute_cli.parent.parent.name != "node_modules":
        raise RuntimeError(f"Changesets CLI must be under node_modules/.bin: {cli}")
    package = absolute_cli.parent.parent / "@changesets/cli/package.json"
    if not package.is_file():
        raise RuntimeError(f"Cannot identify the Changesets package for CLI: {cli}")
    metadata = json.loads(package.read_text(encoding="utf-8"))
    if metadata.get("name") != "@changesets/cli" or metadata.get("version") != PINNED_CHANGESET_VERSION:
        raise RuntimeError(
            f"Expected @changesets/cli {PINNED_CHANGESET_VERSION} at {cli}, "
            f"found {metadata.get('name')} {metadata.get('version')}"
        )
    return absolute_cli


def run(command: list[str], cwd: Path, expect_success: bool) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if (result.returncode == 0) != expect_success:
        raise AssertionError(
            f"Unexpected exit {result.returncode} for {command}:\n{result.stdout}\n{result.stderr}"
        )
    return result


def prepare_private_notes(root: Path) -> subprocess.CompletedProcess[str]:
    return run(
        [sys.executable, str(PREPARE_PRIVATE_RELEASE_NOTES), "--root", str(root)],
        REPO_ROOT,
        expect_success=True,
    )


def default_private_publish(
    cli: Path, root: Path, output_file: Path
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["CHANGESETS_OUTPUT"] = str(output_file)
    # Any accidental registry lookup is confined to a nonexistent local file URL.
    # All fixture workspaces are private, so Changesets must skip npm info/publish and
    # produce only local git-tag events.
    environment["npm_config_registry"] = (root / "missing-registry").as_uri()
    environment["NPM_CONFIG_REGISTRY"] = environment["npm_config_registry"]
    return subprocess.run(
        [str(cli), "publish"], cwd=root, env=environment, capture_output=True, text=True
    )


def exercise() -> None:
    cli = changeset_cli()
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
        # Resolve only the fixture lockfile from local pnpm metadata; do not install
        # packages or run dependency lifecycle scripts in this disposable workspace.
        run(["pnpm", "install", "--offline", "--lockfile-only"], root, expect_success=True)

        def git(*args: str) -> str:
            return subprocess.run(
                ["git", *args], cwd=root, check=True, capture_output=True, text=True
            ).stdout

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Changesets version PR test")
        git("config", "user.email", "changesets-version-pr@example.invalid")
        # Changesets probes origin tags; keep that operation strictly local too.
        git("remote", "add", "origin", (root / "missing-origin").as_uri())
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

        run([str(cli), "version"], root, expect_success=True)
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
            [str(cli), "status", f"--since={base_sha}"], root, expect_success=False
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

        # Simulate the confirmed merge commit. The action's default `changeset publish`
        # path must turn eligible private workspaces into local tag events without any
        # registry access; the separate workflow step has already prepared fallback notes.
        version_pr_sha = git("rev-parse", "HEAD").strip()
        git("switch", "--quiet", "main")
        git("merge", "--quiet", "--no-ff", "--no-edit", "version-pr")
        first_merge_sha = git("rev-parse", "HEAD").strip()
        output_file = root / "changesets-output.ndjson"
        if any(
            json.loads((root / f"packages/{name}/package.json").read_text()).get("private") is not True
            for name in ("api", "client", "independent")
        ):
            raise AssertionError("The registry-free fixture must contain only private workspaces")
        prepared = prepare_private_notes(root)
        if "Prepared fallback changelogs for 1 private package(s)." not in prepared.stdout:
            raise AssertionError(f"Unexpected fallback changelog preparation: {prepared.stdout}")
        result = default_private_publish(cli, root, output_file)
        if result.returncode:
            raise AssertionError(f"Default Changesets publish failed: {result.stdout}\n{result.stderr}")
        first_events = [json.loads(line) for line in output_file.read_text().splitlines() if line]
        first_tags = {event["tag"] for event in first_events if event.get("type") == "git-tag"}
        expected_first_tags = {
            "@fixture/api@0.0.1",
            "@fixture/client@0.0.1",
            "@fixture/independent@0.0.0",
        }
        if first_tags != expected_first_tags:
            raise AssertionError(f"Unfiltered private-package tags differ: {first_tags!r}")
        if any(
            git("rev-parse", f"refs/tags/{tag}^{{}}").strip() != first_merge_sha
            for tag in first_tags
        ):
            raise AssertionError("A Changesets tag did not target the exact merge commit")
        if "Release fixture." not in (root / "packages/api/CHANGELOG.md").read_text():
            raise AssertionError("The emitted release event has no matching changelog entry")
        event_package_dirs = {
            "@fixture/api": root / "packages/api",
            "@fixture/client": root / "packages/client",
            "@fixture/independent": root / "packages/independent",
        }
        if any(
            not (event_package_dirs[event["packageName"]] / "CHANGELOG.md").is_file()
            for event in first_events
            if event.get("type") == "git-tag"
        ):
            raise AssertionError("An emitted release event still lacks an action changelog")
        fallback = (root / "packages/independent/CHANGELOG.md").read_text(encoding="utf-8")
        if "No release notes were recorded" not in fallback:
            raise AssertionError("Fallback release notes are not explicit")
        (root / "packages/independent/CHANGELOG.md").unlink()
        output_file.unlink()

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
        run([str(cli), "version"], root, expect_success=True)
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
                f"The second generated version PR was not accepted by the strict gate: "
                f"{changed_paths(second_base_sha, root)!r}"
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
        prepared = prepare_private_notes(root)
        if "Prepared fallback changelogs for 0 private package(s)." not in prepared.stdout:
            raise AssertionError(f"Unexpected second fallback preparation: {prepared.stdout}")
        result = default_private_publish(cli, root, output_file)
        if result.returncode:
            raise AssertionError(f"Second default Changesets publish failed: {result.stdout}\n{result.stderr}")
        second_tags = {
            json.loads(line)["tag"] for line in output_file.read_text().splitlines()
            if line and json.loads(line).get("type") == "git-tag"
        }
        if second_tags != {
            "@fixture/api@0.0.2",
            "@fixture/client@0.0.2",
            "@fixture/independent@0.0.1",
        }:
            raise AssertionError(f"Second tag events differ: {second_tags!r}")
        output_file.unlink()

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
            "default CLI publish emits tags at exact merge commits for eligible unchanged "
            "private packages without registry access; unrelated lockfile content "
            "is rejected."
        )


if __name__ == "__main__":
    exercise()
