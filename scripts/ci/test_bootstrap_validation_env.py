"""Tests for trusted validation environment bootstrapping."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bootstrap_validation_env as bootstrap


class BootstrapValidationEnvTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name) / "candidate"
        self.workspace.mkdir()

    @patch.object(bootstrap.subprocess, "run")
    def test_supported_interpreter_creates_env_and_installs_trusted_pins(self, run):
        def fake_run(command, **_kwargs):
            if command[1:3] == ["-m", "venv"]:
                executable = Path(command[3]) / "bin" / "python"
                executable.parent.mkdir(parents=True)
                executable.touch()
                return self.completed()
            if ".venv" in command[0]:
                return self.completed("CPython\n3.14\n")
            if command[0].endswith("python3.14"):
                return self.completed("CPython\n3.14\n")
            return self.completed()
        run.side_effect = fake_run
        result = bootstrap.bootstrap(self.workspace, "/host/python3.14")
        self.assertEqual(result, self.workspace.resolve() / ".venv")
        self.assertEqual(run.call_args_list[1].args[0], ["/host/python3.14", "-m", "venv", str(result)])
        install = run.call_args_list[3].args[0]
        self.assertEqual(install[3:7], ["--isolated", "install", "--require-hashes", "--only-binary=:all:"])
        self.assertEqual(install[7], "-r")
        self.assertEqual(install[-1], str(bootstrap.REQUIREMENTS))
        self.assertNotIn(str(self.workspace), install[-1])

    @patch.object(bootstrap.subprocess, "run")
    def test_unsupported_interpreter_fails_without_setup(self, run):
        run.return_value = self.completed("CPython\n3.15\n")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "3.9 through 3.14"):
            bootstrap.bootstrap(self.workspace, "/host/python3.15")
        self.assertEqual(run.call_count, 1)

    @patch.object(bootstrap.subprocess, "run")
    def test_missing_workspace_fails_before_running_interpreter(self, run):
        with self.assertRaisesRegex(bootstrap.BootstrapError, "workspace does not exist"):
            bootstrap.bootstrap(self.workspace / "missing", "/host/python3.14")
        run.assert_not_called()

    @patch.object(bootstrap.subprocess, "run")
    def test_reuses_existing_valid_environment_without_recreating(self, run):
        executable = self.workspace / ".venv" / "bin" / "python"
        executable.parent.mkdir(parents=True)
        executable.touch()
        run.side_effect = [self.completed("CPython\n3.13\n"), self.completed("CPython\n3.13\n"), self.completed()]
        bootstrap.bootstrap(self.workspace, "/host/python3.13")
        self.assertEqual(run.call_count, 3)
        self.assertNotIn("venv", run.call_args_list[1].args[0])

    @patch.object(bootstrap.subprocess, "run")
    def test_malformed_existing_environment_is_preserved(self, run):
        environment = self.workspace / ".venv"
        environment.mkdir()
        run.return_value = self.completed("CPython\n3.12\n")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "refusing to replace"):
            bootstrap.bootstrap(self.workspace, "/host/python3.12")
        self.assertTrue(environment.is_dir())
        self.assertEqual(run.call_count, 1)

    @patch.object(bootstrap.subprocess, "run")
    def test_unsupported_existing_environment_is_not_replaced(self, run):
        executable = self.workspace / ".venv" / "bin" / "python"
        executable.parent.mkdir(parents=True)
        executable.touch()
        run.side_effect = [self.completed("CPython\n3.12\n"), self.completed("CPython\n3.15\n")]
        with self.assertRaisesRegex(bootstrap.BootstrapError, "3.9 through 3.14"):
            bootstrap.bootstrap(self.workspace, "/host/python3.12")
        self.assertTrue(executable.exists())

    @patch.object(bootstrap.subprocess, "run")
    def test_subprocess_failure_is_actionable(self, run):
        run.side_effect = [self.completed("CPython\n3.12\n"), self.completed(returncode=2, stderr="venv failed")]
        with self.assertRaisesRegex(bootstrap.BootstrapError, "venv failed"):
            bootstrap.bootstrap(self.workspace, "/host/python3.12")

    @staticmethod
    def completed(stdout="", returncode=0, stderr=""):
        class Result:
            pass
        result = Result()
        result.stdout = stdout
        result.stderr = stderr
        result.returncode = returncode
        return result


if __name__ == "__main__":
    unittest.main()
