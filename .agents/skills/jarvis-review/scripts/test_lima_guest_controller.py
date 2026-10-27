"""Mocked guest-controller tests; run only inside the isolated Lima guest."""

import unittest
import sys
import tempfile
import json
import os
import stat
import contextlib
import io
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import lima_guest_controller as guest


SCENARIOS = (
    "real PostgreSQL stop controls gate and cancel the real queue worker composition",
    "persisted stop state survives an operating-system worker restart",
)


def output(lines=None, *, totals="ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0"):
    lines = lines or [f"ok {index} - {name}" for index, name in enumerate(SCENARIOS, 1)]
    return "\n".join([*lines, totals])


class GuestControllerTests(unittest.TestCase):
    def test_cli_rejects_incomplete_database_command_without_running_it(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                guest.main(["database"])
        self.assertEqual(result.exception.code, 2)

    def test_parser_requires_both_requested_scenarios_and_zero_skips(self):
        summary, scenarios, passed = guest.parse_test_output(output(), 0, False)
        self.assertTrue(passed)
        self.assertEqual(summary["total"], 2)
        self.assertEqual([item["result"] for item in scenarios], ["passed", "passed"])

    def test_parser_rejects_skipped_scenario_and_any_suite_skip(self):
        lines = [f"ok 1 - {SCENARIOS[0]}", f"ok 2 - {SCENARIOS[1]} # SKIP opt-in absent"]
        self.assertFalse(guest.parse_test_output(output(lines, totals="ℹ tests 2\nℹ pass 1\nℹ fail 0\nℹ skipped 1"),
                                                 0, False)[2])
        self.assertFalse(guest.parse_test_output(output(totals="ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 1"),
                                                 0, False)[2])

    def test_parser_rejects_missing_duplicate_failure_and_count_mismatch(self):
        self.assertFalse(guest.parse_test_output(output([f"ok 1 - {SCENARIOS[0]}"],
                                                         totals="ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ skipped 0"),
                                                 0, False)[2])
        duplicate = [f"ok 1 - {SCENARIOS[0]}", f"ok 2 - {SCENARIOS[0]}"]
        self.assertFalse(guest.parse_test_output(output(duplicate), 0, False)[2])
        failed = [f"ok 1 - {SCENARIOS[0]}", f"not ok 2 - {SCENARIOS[1]}"]
        self.assertFalse(guest.parse_test_output(output(failed, totals="ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ skipped 0"),
                                                 1, False)[2])
        self.assertFalse(guest.parse_test_output(output(), 0, True)[2])

    def test_guest_command_output_is_bounded_and_timeout_is_reaped(self):
        with self.assertRaisesRegex(guest.GuestError, "output exceeded"):
            guest.run([sys.executable, "-c", "print('x' * 1000000)"],
                      timeout=5, output_limit=1024)
        with self.assertRaisesRegex(guest.GuestError, "timed out"):
            guest.run([sys.executable, "-c", "import time; time.sleep(30)"],
                      timeout=0.1, output_limit=1024)

    def test_failing_guest_command_reports_actual_child_exit_code(self):
        with self.assertRaisesRegex(guest.GuestError, r"exit 7\)$"):
            guest.run([sys.executable, "-c", "raise SystemExit(7)"], timeout=5)

    def test_streamed_candidate_log_is_capped_at_write_time(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "candidate.log"
            with log.open("wb") as output_file:
                with self.assertRaisesRegex(guest.GuestError, "output exceeded"):
                    guest.run_bounded([sys.executable, "-c", "print('x' * 1000000)"],
                                      timeout=5, output_limit=1024, output_file=output_file)
            self.assertEqual(log.stat().st_size, 1024)

    @patch.object(guest, "run")
    @patch.object(guest.os, "geteuid", return_value=0)
    def test_cleanup_removes_only_exact_recorded_container(self, _geteuid, command):
        image = "postgres:18.6@sha256:" + "a" * 64
        run_id = "b" * 32
        name = guest.DB_NAME_PREFIX + run_id
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = root / "postgres-container"
            container_id = "d" * 64
            image_id = "sha256:" + "c" * 64
            identity.write_text(json.dumps({"schema": 1, "name": name, "run_id": run_id,
                                            "container_id": container_id, "image_id": image_id,
                                            "digest": image.split("@", 1)[1]}))
            identity.chmod(0o600)
            attempt = root / "database-attempt"
            attempt.write_text(name)
            attempt.chmod(0o600)
            paths = [root / "postgres.env", root / "database-url", root / "candidate.env",
                     root / "persistence-test.log"]
            for path in paths:
                path.write_text("secret-or-output")
            with patch.object(guest, "ROOT", root), patch.object(guest, "DB_ATTEMPT", attempt), \
                 patch.object(guest, "DB_ENV", paths[0]), \
                 patch.object(guest, "DB_URL", paths[1]), patch.object(guest, "CANDIDATE_ENV", paths[2]), \
                 patch.object(guest, "TEST_LOG", paths[3]):
                original_stat = os.stat
                def simulated_root_stat(path, *args, **kwargs):
                    if os.fspath(path) == os.fspath(root):
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o711)
                    if os.fspath(path) == os.fspath(identity):
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
                    return original_stat(path, *args, **kwargs)
                command.side_effect = [
                    f'{image_id} ["docker.io/library/postgres:18.6@{image.split("@", 1)[1]}"]',
                    f"{container_id} {image_id} {run_id}", "",
                ]
                with patch.object(guest.os, "stat", side_effect=simulated_root_stat):
                    guest.cleanup(type("Args", (), {"postgres_image": image})())
            calls = [call.args[0] for call in command.call_args_list]
            self.assertEqual(calls[0][-1], image)
            self.assertEqual(calls[1][-1], container_id)
            self.assertEqual(calls[2][-1], container_id)
            self.assertTrue(all(not call[0:2] == ["podman", "ps"] for call in calls))
            self.assertFalse(identity.exists())
            self.assertFalse(attempt.exists())
            self.assertTrue(all(not path.exists() for path in paths))

    @patch.object(guest, "run")
    @patch.object(guest.os, "geteuid", return_value=0)
    def test_cleanup_never_removes_container_when_inspected_id_mismatches(self, _geteuid, command):
        image = "postgres:18.6@sha256:" + "a" * 64
        run_id = "b" * 32
        name = guest.DB_NAME_PREFIX + run_id
        container_id = "d" * 64
        image_id = "sha256:" + "c" * 64
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = root / "postgres-container"
            identity.write_text(json.dumps({"name": name, "run_id": run_id,
                                            "container_id": container_id, "image_id": image_id,
                                            "digest": image.split("@", 1)[1]}))
            identity.chmod(0o600)
            marker = root / "database-attempt"
            marker.write_text(name)
            marker.chmod(0o600)
            with patch.object(guest, "ROOT", root), patch.object(guest, "DB_ATTEMPT", marker):
                original_stat = os.stat
                def simulated_root_stat(path, *args, **kwargs):
                    if os.fspath(path) == os.fspath(root):
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o711)
                    if os.fspath(path) == os.fspath(identity):
                        return SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
                    return original_stat(path, *args, **kwargs)
                command.side_effect = [f'{image_id} ["postgres@{image.split("@", 1)[1]}"]',
                                       f"{'e' * 64} {image_id} {run_id}"]
                with patch.object(guest.os, "stat", side_effect=simulated_root_stat):
                    with self.assertRaisesRegex(guest.GuestError, "identity mismatch"):
                        guest.cleanup(type("Args", (), {"postgres_image": image})())
            self.assertFalse(any(call.args[0][:3] == ["podman", "rm", "--force"]
                                 for call in command.call_args_list))

    @patch.object(guest, "run")
    @patch.object(guest.subprocess, "run")
    @patch.object(guest.os, "geteuid", return_value=0)
    @patch.object(guest, "inspect_image", return_value="sha256:" + "c" * 64)
    @patch.object(guest.secrets, "token_hex", return_value="b" * 32)
    def test_database_startup_failure_removes_its_exact_container_and_secrets(
            self, _token, _image, _root, process, command):
        image = "postgres:18.6@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_env, db_url = root / "postgres.env", root / "database-url"
            identity = root / "postgres-container"
            marker = root / "database-attempt"
            with patch.object(guest, "ROOT", root), patch.object(guest, "DB_ENV", db_env), \
                 patch.object(guest, "DB_URL", db_url), patch.object(guest, "DB_ATTEMPT", marker):
                # Force readiness timeout without contacting Podman.
                process.side_effect = [
                    SimpleNamespace(returncode=1),
                    SimpleNamespace(returncode=0, stdout=f"{'d' * 64} {'sha256:' + 'c' * 64} {'b' * 32}"),
                    SimpleNamespace(returncode=0),
                ]
                command.return_value = "d" * 64
                with patch.object(guest.time, "monotonic", side_effect=[0, 0, 100]), \
                     patch.object(guest.time, "sleep"):
                    with self.assertRaisesRegex(guest.GuestError, "did not become ready"):
                        guest.start_database(type("Args", (), {"postgres_image": image})())
            self.assertFalse(db_env.exists())
            self.assertFalse(db_url.exists())
            self.assertFalse(identity.exists())
            self.assertFalse(marker.exists())
            rm_calls = [call.args[0] for call in process.call_args_list
                        if call.args[0][:3] == ["podman", "rm", "--force"]]
            self.assertEqual(len(rm_calls), 1)
            self.assertEqual(rm_calls[0][-1], "d" * 64)

    @patch.object(guest.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=""))
    @patch.object(guest, "run", return_value="a" * 64)
    @patch.object(guest, "inspect_image", return_value="sha256:" + "c" * 64)
    @patch.object(guest.os, "geteuid", return_value=0)
    @patch.object(guest.secrets, "token_hex", return_value="b" * 32)
    def test_uncertain_database_startup_preserves_attempt_and_secrets(
            self, _token, _geteuid, _image, command, _process):
        image = "postgres:18.6@sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env, url, marker = root / "postgres.env", root / "database-url", root / "database-attempt"
            with patch.object(guest, "ROOT", root), patch.object(guest, "DB_ENV", env), \
                 patch.object(guest, "DB_URL", url), patch.object(guest, "DB_ATTEMPT", marker):
                with patch.object(guest.time, "monotonic", side_effect=[0, 0, 100]), \
                     patch.object(guest.time, "sleep"):
                    with self.assertRaisesRegex(guest.GuestError, "cleanup is uncertain"):
                        guest.start_database(type("Args", (), {"postgres_image": image})())
            self.assertTrue(marker.exists())
            self.assertTrue(env.exists())
            self.assertTrue(url.exists())


if __name__ == "__main__":
    unittest.main()
