"""Tests for the PR Changeset package-target gate."""

from contextlib import redirect_stdout
from io import StringIO
import json
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath

from check_changeset_package_scope import (
    changeset_coverage_error,
    changed_workspace_names,
    parse_changeset,
    validate,
)


class ChangesetPackageScopeTests(unittest.TestCase):
    def test_changed_paths_map_to_the_containing_workspace(self):
        packages = {
            PurePosixPath("apps/api"): "@jarvis/api",
            PurePosixPath("packages/domain"): "@jarvis/domain",
        }
        changed = changed_workspace_names(
            [PurePosixPath("apps/api/src/index.ts"), PurePosixPath("docs/readme.md")], packages
        )
        self.assertEqual(changed, {"@jarvis/api"})

    def test_changeset_targets_an_impacted_package(self):
        self.assertIsNone(changeset_coverage_error({"@jarvis/api"}, [{"@jarvis/api"}]))

    def test_unrelated_changeset_does_not_cover_changed_package(self):
        error = changeset_coverage_error({"@jarvis/api"}, [{"@jarvis/domain"}])
        self.assertIn("@jarvis/api", error)
        self.assertIn("@jarvis/domain", error)

    def test_explicit_empty_changeset_allows_no_release_package_change(self):
        self.assertIsNone(changeset_coverage_error({"@jarvis/api"}, [set()]))

    def test_no_changed_versionable_packages_needs_no_changeset(self):
        self.assertIsNone(changeset_coverage_error(set(), []))

    def test_frontmatter_parses_release_and_empty_changesets(self):
        self.assertEqual(parse_changeset("---\n'@jarvis/api': patch\n---\nFix API.\n"), {"@jarvis/api"})
        self.assertEqual(parse_changeset("---\n\n---\nNo release.\n"), set())
        self.assertIsNone(parse_changeset("# Changesets\nDocumentation only.\n"))

    def test_validation_rejects_a_changeset_for_an_untouched_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/domain': patch")
            with self.assertRaisesRegex(ValueError, "@jarvis/api.*@jarvis/domain"):
                validate("main", root)

    def test_validation_accepts_a_changeset_for_a_changed_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/api': patch")
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_validation_accepts_an_explicit_empty_no_release_changeset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "")
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    @staticmethod
    def make_fixture(root: Path, changeset_frontmatter: str) -> Path:
        (root / ".changeset").mkdir()
        (root / "packages/api").mkdir(parents=True)
        (root / "packages/domain").mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps({"name": "fixture", "version": "1.0.0", "private": True}), encoding="utf-8"
        )
        (root / "pnpm-workspace.yaml").write_text("packages:\n  - packages/*\n", encoding="utf-8")
        (root / ".changeset/config.json").write_text(
            json.dumps({"privatePackages": {"version": True}, "ignore": []}), encoding="utf-8"
        )
        for name in ("api", "domain"):
            (root / f"packages/{name}/package.json").write_text(
                json.dumps({"name": f"@jarvis/{name}", "version": "1.0.0", "private": True}),
                encoding="utf-8",
            )

        def git(*args: str) -> None:
            subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Changeset CI test")
        git("config", "user.email", "ci-test@example.invalid")
        git("add", ".")
        git("commit", "--quiet", "-m", "fixture baseline")
        git("switch", "--quiet", "--create", "pr")
        (root / "packages/api/index.js").write_text("export const changed = true;\n", encoding="utf-8")
        (root / ".changeset/unrelated.md").write_text(
            f"---\n{changeset_frontmatter}\n---\nFixture change.\n", encoding="utf-8"
        )
        git("add", ".")
        git("commit", "--quiet", "-m", "change api package")
        return root


if __name__ == "__main__":
    unittest.main()
