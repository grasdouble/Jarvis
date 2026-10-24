"""Tests for the PR Changeset package-target gate."""

from contextlib import redirect_stdout
from io import StringIO
import json
import shutil
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
        self.assertIsNotNone(changeset_coverage_error({"@jarvis/api"}, [set()]))

    def test_every_changed_workspace_requires_its_own_changeset_coverage(self):
        error = changeset_coverage_error({"@jarvis/api", "@jarvis/domain"}, [{"@jarvis/api"}])
        self.assertIsNotNone(error)
        self.assertIn("@jarvis/domain", error)

    def test_no_changed_versionable_packages_needs_no_changeset(self):
        self.assertIsNone(changeset_coverage_error(set(), []))

    def test_frontmatter_parses_release_and_empty_changesets(self):
        self.assertEqual(parse_changeset("---\n'@jarvis/api': patch\n---\nFix API.\n"), {"@jarvis/api"})
        self.assertEqual(parse_changeset("---\n\n---\nNo release.\n"), set())
        self.assertIsNone(parse_changeset("# Changesets\nDocumentation only.\n"))

    def test_validation_rejects_a_changeset_for_an_untouched_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/domain': patch")
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root)

    def test_validation_maps_recursive_workspace_globs_like_pnpm(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(
                Path(temporary), "'@jarvis/domain': patch", recursive_workspace_glob=True
            )
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root)

    def test_recursive_workspace_negation_is_not_overridden_by_later_inclusion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(
                Path(temporary), "'@jarvis/domain': patch", reinclude_excluded_workspace=True
            )
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_validation_rejects_an_unrelated_changeset_for_deleted_package_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/domain': patch", delete_api_file=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root)

    def test_move_out_of_all_head_workspaces_does_not_require_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, rename_api_file_to_docs=True)
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_moved_file_is_mapped_to_head_workspace_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, move_api_file_to_domain=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/domain"):
                validate("main", root)

    def test_validation_does_not_require_changeset_for_removed_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, delete_api_workspace=True)
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_stale_changeset_target_for_package_absent_at_head_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/api': patch", delete_api_workspace=True)
            with self.assertRaisesRegex(ValueError, "absent from the PR-head workspace set.*@jarvis/api"):
                validate("main", root)

    def test_unchanged_base_changeset_with_stale_target_does_not_block_unrelated_source_pr(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(
                Path(temporary),
                None,
                delete_api_workspace=True,
                stale_base_changeset=True,
                unrelated_source_change=True,
            )
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_validation_ignores_deleted_changeset_files_without_reading_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(
                Path(temporary), None, delete_base_changeset=True
            )
            with self.assertRaisesRegex(ValueError, "individual Changeset coverage"):
                validate("main", root)

    def test_validation_accepts_a_changeset_for_a_changed_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/api': patch")
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_validation_uses_candidate_policy_when_base_has_no_changesets_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(
                Path(temporary), "'@jarvis/api': patch", add_changeset_config_in_pr=True
            )
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root), "passed")

    def test_validation_rejects_an_explicit_empty_no_release_changeset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "")
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root)

    def test_validation_requires_coverage_for_each_changed_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/api': patch", change_domain=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/domain"):
                validate("main", root)

    def test_configured_exclusion_requires_every_changed_path_to_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, excluded_file_change=True)
            with redirect_stdout(StringIO()):
                self.assertEqual(validate("main", root, ["packages/api/generated/**"]), "passed")
            root = self.make_fixture(Path(temporary) / "mixed", None, mixed_excluded_change=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root, ["packages/api/generated/**"])

    def test_new_workspace_in_head_requires_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, add_workspace=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/new"):
                validate("main", root)

    def test_workspace_name_change_requires_current_name_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, rename_api_package=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/renamed"):
                validate("main", root)

    def test_workspace_path_change_requires_new_path_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), None, move_api_workspace=True)
            with self.assertRaisesRegex(ValueError, "@jarvis/api"):
                validate("main", root)

    def test_workspace_discovery_uses_pr_head_not_target_only_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_fixture(Path(temporary), "'@jarvis/api': patch")

            def git(*args):
                return subprocess.run(
                    ["git", *args], cwd=root, check=True, capture_output=True, text=True
                ).stdout.strip()

            pr_head = git("rev-parse", "HEAD")
            git("switch", "main")
            target_only = root / "packages/target-only"
            target_only.mkdir()
            (target_only / "package.json").write_text(
                json.dumps({"name": "@jarvis/target-only", "version": "1.0.0", "private": True}),
                encoding="utf-8",
            )
            git("add", ".")
            git("commit", "--quiet", "-m", "add target-only workspace")
            target = git("rev-parse", "HEAD")
            git("merge", "--quiet", "--no-ff", "--no-edit", "pr")

            with redirect_stdout(StringIO()):
                self.assertEqual(validate(target, root, head_sha=pr_head), "passed")

    @staticmethod
    def make_fixture(
        root: Path,
        changeset_frontmatter: str | None,
        delete_api_file: bool = False,
        rename_api_file_to_docs: bool = False,
        delete_api_workspace: bool = False,
        delete_base_changeset: bool = False,
        exclude_api_workspace: bool = False,
        add_changeset_config_in_pr: bool = False,
        recursive_workspace_glob: bool = False,
        reinclude_excluded_workspace: bool = False,
        change_domain: bool = False,
        excluded_file_change: bool = False,
        mixed_excluded_change: bool = False,
        add_workspace: bool = False,
        rename_api_package: bool = False,
        move_api_workspace: bool = False,
        move_api_file_to_domain: bool = False,
        stale_base_changeset: bool = False,
        unrelated_source_change: bool = False,
    ) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        (root / ".changeset").mkdir()
        api_root = (
            Path("packages/area/keep")
            if reinclude_excluded_workspace
            else Path("packages/nested/api")
            if recursive_workspace_glob
            else Path("packages/api")
        )
        (root / api_root).mkdir(parents=True)
        (root / "packages/domain").mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps({"name": "fixture", "version": "1.0.0", "private": True}), encoding="utf-8"
        )
        if reinclude_excluded_workspace:
            workspace_yaml = "packages:\n  - 'packages/**'\n  - '!packages/area/**'\n  - packages/area/keep\n"
        else:
            workspace_pattern = "packages/**" if recursive_workspace_glob else "packages/*"
            workspace_yaml = f"packages:\n  - {workspace_pattern}\n"
        (root / "pnpm-workspace.yaml").write_text(workspace_yaml, encoding="utf-8")
        if not add_changeset_config_in_pr:
            (root / ".changeset/config.json").write_text(
                json.dumps({"privatePackages": {"version": True}, "ignore": []}), encoding="utf-8"
            )
        for name, package_root in (("api", api_root), ("domain", Path("packages/domain"))):
            (root / package_root / "package.json").write_text(
                json.dumps({"name": f"@jarvis/{name}", "version": "1.0.0", "private": True}),
                encoding="utf-8",
            )
        api_file = root / api_root / "index.js"
        api_file.write_text("export const existing = true;\n", encoding="utf-8")
        if delete_base_changeset or stale_base_changeset:
            (root / ".changeset/base.md").write_text(
                "---\n'@jarvis/api': patch\n---\nBase release entry.\n", encoding="utf-8"
            )

        def git(*args: str) -> None:
            subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)

        git("init", "--quiet", "--initial-branch=main")
        git("config", "user.name", "Changeset CI test")
        git("config", "user.email", "ci-test@example.invalid")
        git("add", ".")
        git("commit", "--quiet", "-m", "fixture baseline")
        git("switch", "--quiet", "--create", "pr")
        if delete_base_changeset:
            (root / ".changeset/base.md").unlink()
        if unrelated_source_change:
            (root / "README.md").write_text("Unrelated repository documentation change.\n", encoding="utf-8")
        if add_changeset_config_in_pr:
            (root / ".changeset/config.json").write_text(
                json.dumps({"privatePackages": {"version": True}, "ignore": []}), encoding="utf-8"
            )
        if exclude_api_workspace:
            (root / "pnpm-workspace.yaml").write_text(
                "packages:\n  - packages/*\n  - '!packages/api'\n", encoding="utf-8"
            )
        if delete_api_workspace:
            shutil.rmtree(root / api_root)
        elif rename_api_file_to_docs:
            (root / "docs").mkdir()
            api_file.rename(root / "docs/api-index.js")
        elif move_api_file_to_domain:
            api_file.rename(root / "packages/domain/api-index.js")
        elif delete_api_file:
            api_file.unlink()
        elif not excluded_file_change and not mixed_excluded_change:
            api_file.write_text("export const changed = true;\n", encoding="utf-8")
        if excluded_file_change or mixed_excluded_change:
            generated = root / "packages/api/generated/output.js"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
        if mixed_excluded_change:
            api_file.write_text("export const changed = true;\n", encoding="utf-8")
        if change_domain:
            (root / "packages/domain/index.js").write_text("export const changed = true;\n", encoding="utf-8")
        if add_workspace:
            new_package = root / "packages/new"
            new_package.mkdir()
            (new_package / "package.json").write_text(
                json.dumps({"name": "@jarvis/new", "version": "1.0.0", "private": True}),
                encoding="utf-8",
            )
        if rename_api_package:
            manifest = json.loads((root / api_root / "package.json").read_text(encoding="utf-8"))
            manifest["name"] = "@jarvis/renamed"
            (root / api_root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
        if move_api_workspace:
            moved = root / "packages/moved"
            shutil.move(root / api_root, moved)
            (root / "pnpm-workspace.yaml").write_text(
                "packages:\n  - packages/*\n  - '!packages/api'\n", encoding="utf-8"
            )
        if changeset_frontmatter is not None:
            (root / ".changeset/unrelated.md").write_text(
                f"---\n{changeset_frontmatter}\n---\nFixture change.\n", encoding="utf-8"
            )
        git("add", ".")
        git("commit", "--quiet", "-m", "change api package")
        return root


if __name__ == "__main__":
    unittest.main()
