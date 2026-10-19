"""Tests for recognizing generated Changesets version PRs conservatively."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from check_changeset_pr import is_changesets_version_pr


class ChangesetsVersionPrTests(unittest.TestCase):
    def test_version_only_changeset_output_is_recognized(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, base = self.make_version_pr(Path(temporary))
            self.assertTrue(is_changesets_version_pr(base, root))

    def test_version_output_with_source_changes_is_not_exempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, base = self.make_version_pr(Path(temporary))
            (root / "packages/api/index.js").write_text("export const changed = true;\n", encoding="utf-8")
            self.git(root, "add", ".")
            self.git(root, "commit", "--quiet", "-m", "mix source change into version PR")
            self.assertFalse(is_changesets_version_pr(base, root))

    @classmethod
    def make_version_pr(cls, root: Path) -> tuple[Path, str]:
        (root / ".changeset").mkdir()
        (root / "packages/api").mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps({"name": "fixture", "private": True, "version": "1.0.0"}), encoding="utf-8"
        )
        (root / "pnpm-workspace.yaml").write_text("packages:\n  - packages/*\n", encoding="utf-8")
        (root / ".changeset/config.json").write_text(
            json.dumps({"privatePackages": {"version": True}, "ignore": []}), encoding="utf-8"
        )
        (root / "packages/api/package.json").write_text(
            json.dumps({"name": "@fixture/api", "private": True, "version": "1.0.0"}), encoding="utf-8"
        )
        (root / "packages/api/index.js").write_text("export const original = true;\n", encoding="utf-8")
        (root / ".changeset/release.md").write_text(
            "---\n'@fixture/api': patch\n---\nRelease fixture.\n", encoding="utf-8"
        )
        cls.git(root, "init", "--quiet", "--initial-branch=main")
        cls.git(root, "config", "user.name", "Changeset CI test")
        cls.git(root, "config", "user.email", "ci-test@example.invalid")
        cls.git(root, "add", ".")
        cls.git(root, "commit", "--quiet", "-m", "fixture baseline")
        base = cls.git(root, "rev-parse", "HEAD").strip()
        cls.git(root, "switch", "--quiet", "--create", "version-pr")
        before = json.loads((root / "packages/api/package.json").read_text(encoding="utf-8"))
        before["version"] = "1.0.1"
        (root / "packages/api/package.json").write_text(json.dumps(before), encoding="utf-8")
        (root / "packages/api/CHANGELOG.md").write_text("# @fixture/api\n\n## 1.0.1\n\n- Release fixture.\n", encoding="utf-8")
        (root / ".changeset/release.md").unlink()
        cls.git(root, "add", "-A")
        cls.git(root, "commit", "--quiet", "-m", "generated version PR")
        return root, base

    @staticmethod
    def git(root: Path, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


if __name__ == "__main__":
    unittest.main()
