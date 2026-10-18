"""Behavioral tests for the bundled PR-review workspace helper."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = Path(__file__).with_name("prepare_validation_workspace.py")
def safe_git_environment(home):
    return {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "LC_ALL": "C",
    }


def git(repo, *args, env=None, check=True):
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode:
        raise AssertionError(result.stderr.decode("utf-8", errors="replace"))
    return result


class PrepareValidationWorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="jarvis-review-test-")
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.repo = self.root / "source"
        self.repo.mkdir()
        self.git_env = safe_git_environment(self.home)
        git(self.repo, "init", "--quiet", "--initial-branch=main", env=self.git_env)
        git(self.repo, "config", "user.name", "Validation Fixture", env=self.git_env)
        git(self.repo, "config", "user.email", "fixture@example.invalid", env=self.git_env)
        (self.repo / "README.md").write_text("base\n")
        git(self.repo, "add", "README.md", env=self.git_env)
        git(self.repo, "commit", "--quiet", "-m", "base fixture", env=self.git_env)
        self.base = git(self.repo, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip()

        (self.repo / "README.md").write_text("head\n")
        (self.repo / "module.py").write_text("answer = 42\n")
        (self.repo / "shortcut").symlink_to("module.py")
        (self.repo / ".gitattributes").write_text("*.secret filter=fixture\n")
        (self.repo / "payload.secret").write_text("review fixture\n")
        git(self.repo, "add", "README.md", "module.py", "shortcut",
            ".gitattributes", "payload.secret", env=self.git_env)
        git(self.repo, "commit", "--quiet", "-m", "head fixture", env=self.git_env)
        self.head = git(self.repo, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip()
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.base, env=self.git_env)
        git(self.repo, "config", "credential.helper", "fixture-secret-helper", env=self.git_env)

        git(self.repo, "switch", "--quiet", "-c", "unrelated", env=self.git_env)
        (self.repo / "unrelated.txt").write_text("unrelated branch\n")
        git(self.repo, "add", "unrelated.txt", env=self.git_env)
        git(self.repo, "commit", "--quiet", "-m", "unrelated fixture", env=self.git_env)
        self.unrelated = git(self.repo, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip()
        git(self.repo, "switch", "--quiet", "main", env=self.git_env)
        self.destination = self.root / "validation-copy"

    def tearDown(self):
        self.temporary.cleanup()

    def invoke(self, *args, extra_env=None):
        env = dict(os.environ)
        env.update(self.git_env)
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            [sys.executable, str(HELPER), *map(str, args)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def prepare(self, destination=None, extra_env=None):
        return self.invoke(
            "prepare",
            "--repo", self.repo,
            "--base", self.base,
            "--head", self.head,
            "--destination", destination or self.destination,
            extra_env=extra_env,
        )

    def test_prepares_exact_head_without_copying_source_configuration_or_other_branches(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout.decode())
        summary = json.loads(result.stdout)
        self.assertEqual(summary["status"], "prepared")
        self.assertEqual(summary["source"]["base"], self.base)
        self.assertEqual(summary["source"]["head"], self.head)
        self.assertEqual(summary["source"]["merge_base"], self.base)
        self.assertEqual(summary["source"]["head_tree"], git(
            self.repo, "rev-parse", f"{self.head}^{{tree}}", env=self.git_env
        ).stdout.decode().strip())
        self.assertEqual(git(self.destination, "rev-parse", "HEAD", env=self.git_env)
                         .stdout.decode().strip(), self.head)
        self.assertEqual(git(self.destination, "remote", env=self.git_env).stdout, b"")
        self.assertFalse((self.destination / ".git" / "hooks").exists())
        self.assertNotEqual(git(self.destination, "cat-file", "-e", self.unrelated,
                                env=self.git_env, check=False).returncode, 0)
        self.assertFalse((self.destination / "unrelated.txt").exists())
        self.assertEqual((self.destination / "shortcut").readlink(), Path("module.py"))
        self.assertEqual(git(self.destination, "status", "--porcelain",
                             "--untracked-files=all", env=self.git_env).stdout, b"")
        self.assertEqual(
            git(self.repo, "for-each-ref", "--format=%(refname) %(objectname)",
                env=self.git_env).stdout.decode().count("refs/jarvis-validation/"),
            0,
        )
        local_config = git(self.destination, "config", "--local", "--list",
                           env=self.git_env).stdout.decode()
        self.assertNotIn("user.name=", local_config)
        self.assertNotIn("credential.", local_config)
        self.assertIn("core.hookspath=/dev/null", local_config.lower())
        self.assertNotIn("fixture-secret-helper", local_config)
        self.assertEqual(
            git(self.repo, "for-each-ref", "--format=%(refname) %(objectname)",
                env=self.git_env).stdout.decode().count("refs/jarvis-validation/"),
            0,
        )

        verified = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(verified.returncode, 0, verified.stderr.decode())
        self.assertEqual(json.loads(verified.stdout)["status"], "verified")

    def test_includes_a_non_ancestor_base_from_its_exact_existing_ref(self):
        git(self.repo, "switch", "--quiet", "-c", "target-base", self.base, env=self.git_env)
        (self.repo / "target-only.txt").write_text("new target history\n")
        git(self.repo, "add", "target-only.txt", env=self.git_env)
        git(self.repo, "commit", "--quiet", "-m", "target base fixture", env=self.git_env)
        target_base = git(self.repo, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip()
        git(self.repo, "update-ref", "refs/remotes/origin/target", target_base, env=self.git_env)
        git(self.repo, "switch", "--quiet", "main", env=self.git_env)
        destination = self.root / "diverged-base-copy"

        result = self.invoke(
            "prepare", "--repo", self.repo, "--base", target_base,
            "--head", self.head, "--destination", destination,
        )
        self.assertEqual(result.returncode, 0, result.stdout.decode())
        self.assertEqual(
            git(destination, "merge-base", target_base, self.head, env=self.git_env)
            .stdout.decode().strip(),
            self.base,
        )
        self.assertEqual(
            git(destination, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip(),
            self.head,
        )

    def test_does_not_apply_caller_global_git_filters(self):
        smudge_marker = self.root / "smudge-ran"
        smudge_command = self.root / "smudge.sh"
        smudge_command.write_text(f'#!/bin/sh\ntouch "{smudge_marker}"\ncat\n')
        smudge_command.chmod(0o755)
        global_config = self.root / "global.gitconfig"
        global_config.write_text(
            '[filter "fixture"]\n'
            f'    smudge = {smudge_command}\n'
        )
        result = self.prepare(extra_env={"GIT_CONFIG_GLOBAL": str(global_config)})
        self.assertEqual(result.returncode, 0, result.stdout.decode())
        self.assertFalse(smudge_marker.exists())

    def test_rejects_dirty_source_without_creating_destination(self):
        (self.repo / "README.md").write_text("uncommitted\n")
        result = self.prepare()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.destination.exists())

    def test_rejects_untracked_source_file(self):
        (self.repo / "untracked.txt").write_text("must not be copied\n")
        result = self.prepare()
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.destination.exists())

    def test_rejects_invalid_revision(self):
        result = self.invoke(
            "prepare", "--repo", self.repo, "--base", "main",
            "--head", self.head, "--destination", self.destination,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.destination.exists())

    def test_rejects_existing_destination(self):
        self.destination.mkdir()
        result = self.prepare()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_rejects_workspace_inside_source_checkout(self):
        destination = self.repo / "validation-copy"
        result = self.prepare(destination)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(destination.exists())

    def test_verification_detects_modified_added_and_removed_files(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout.decode())

        (self.destination / "module.py").write_text("answer = 0\n")
        modified = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(modified.returncode, 1)
        self.assertEqual(json.loads(modified.stdout)["status"], "mismatch")

        (self.destination / "module.py").write_text("answer = 42\n")
        (self.destination / "added.txt").write_text("unexpected\n")
        added = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(added.returncode, 1)
        self.assertEqual(json.loads(added.stdout)["status"], "mismatch")
        (self.destination / "added.txt").unlink()

        (self.destination / "module.py").unlink()
        removed = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(removed.returncode, 1)
        self.assertEqual(json.loads(removed.stdout)["status"], "mismatch")

    def test_verification_detects_git_index_config_and_ref_changes(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout.decode())

        (self.destination / "module.py").write_text("answer = 43\n")
        git(self.destination, "add", "module.py", env=self.git_env)
        staged = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(staged.returncode, 1)
        self.assertIn("index-tree", json.loads(staged.stdout)["error"])
        git(self.destination, "reset", "--quiet", "HEAD", env=self.git_env)
        (self.destination / "module.py").write_text("answer = 42\n")

        git(self.destination, "config", "--local", "credential.helper", "unexpected", env=self.git_env)
        changed_config = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(changed_config.returncode, 1)
        self.assertIn("git-config", json.loads(changed_config.stdout)["error"])
        git(self.destination, "config", "--local", "--unset", "credential.helper", env=self.git_env)

        git(self.destination, "update-ref", "refs/heads/unexpected", self.head, env=self.git_env)
        changed_refs = self.invoke("verify", "--workspace", self.destination)
        self.assertEqual(changed_refs.returncode, 1)
        self.assertIn("git-refs", json.loads(changed_refs.stdout)["error"])

    def test_rejects_symlink_that_escapes_workspace(self):
        git(self.repo, "switch", "--quiet", "-c", "unsafe", env=self.git_env)
        (self.repo / "outside").symlink_to("../../outside")
        git(self.repo, "add", "outside", env=self.git_env)
        git(self.repo, "commit", "--quiet", "-m", "unsafe symlink fixture", env=self.git_env)
        unsafe_head = git(self.repo, "rev-parse", "HEAD", env=self.git_env).stdout.decode().strip()
        result = self.invoke(
            "prepare", "--repo", self.repo, "--base", self.base,
            "--head", unsafe_head, "--destination", self.destination,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
