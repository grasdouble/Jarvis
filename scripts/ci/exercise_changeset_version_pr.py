"""Exercise the Changesets PR gate against the pinned CLI's generated version output."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from check_changeset_package_scope import changed_paths, workspace_packages
from check_changeset_pr import is_changesets_version_pr


REPO_ROOT = Path(__file__).resolve().parents[2]
VERSION_PR_GATE = REPO_ROOT / "scripts/ci/check_changeset_pr.py"
PACKAGE_SCOPE_GATE = REPO_ROOT / "scripts/ci/check_changeset_package_scope.py"


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
        (root / "package.json").write_text(
            json.dumps(
                {
                    "name": "version-pr-fixture",
                    "private": True,
                    "version": "1.0.0",
                    "scripts": {"changeset": "changeset"},
                    "packageManager": "pnpm@12.5.1",
                }
            ),
            encoding="utf-8",
        )
        (root / ".gitignore").write_text("node_modules\n", encoding="utf-8")
        (root / "pnpm-workspace.yaml").write_text("packages:\n  - packages/*\n", encoding="utf-8")
        (root / ".changeset/config.json").write_text(
            (REPO_ROOT / ".changeset/config.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
        (root / "packages/api/package.json").write_text(
            json.dumps({"name": "@fixture/api", "private": True, "version": "0.0.0"}), encoding="utf-8"
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
        (root / ".changeset/release.md").write_text(
            "---\n'@fixture/api': patch\n---\nRelease fixture.\n", encoding="utf-8"
        )
        os.symlink(REPO_ROOT / "node_modules", root / "node_modules", target_is_directory=True)

        run(["pnpm", "install", "--offline", "--lockfile-only"], root, expect_success=True)

        def git(*args: str) -> str:
            return subprocess.run(
                ["git", *args], cwd=root, check=True, capture_output=True, text=True
            ).stdout

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Changesets version PR test")
        git("config", "user.email", "changesets-version-pr@example.invalid")
        git("add", ".gitignore", "package.json", "pnpm-workspace.yaml", ".changeset", "packages")
        git("commit", "--quiet", "-m", "base with pending Changeset")
        base_sha = git("rev-parse", "HEAD").strip()
        git("switch", "--quiet", "--create", "version-pr")

        run(["pnpm", "changeset", "version"], root, expect_success=True)
        package = json.loads((root / "packages/api/package.json").read_text(encoding="utf-8"))
        if package.get("version") != "0.0.1" or not (root / "packages/api/CHANGELOG.md").is_file():
            raise AssertionError("Pinned Changesets version command did not produce the expected version PR files")
        client = json.loads((root / "packages/client/package.json").read_text(encoding="utf-8"))
        if client.get("dependencies", {}).get("@fixture/api") != "workspace:^0.0.1":
            raise AssertionError("Changesets version command did not update the internal workspace range")
        run(["pnpm", "install", "--offline", "--lockfile-only"], root, expect_success=True)
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
        gate_result = run([sys.executable, str(VERSION_PR_GATE), base_sha], root, expect_success=True)
        if "no changesets were found" not in (raw_status.stdout + raw_status.stderr).lower():
            raise AssertionError("The fixture did not reproduce the ordinary status-check failure")
        if "changeset" not in (scope_result.stdout + scope_result.stderr).lower():
            raise AssertionError("The fixture did not reproduce the ordinary target-check failure")
        if "Generated Changesets version PR detected" not in gate_result.stdout:
            raise AssertionError("The unified PR gate did not recognize the generated version PR")
        print("Generated version PR is recognized; raw source status and target gates fail; unified gate passes.")


if __name__ == "__main__":
    exercise()
