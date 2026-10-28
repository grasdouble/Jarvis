"""Mocked lifecycle coverage; execute only inside the isolated Lima guest."""

import tempfile
import sys
import json
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import run_lima_persistence_validation as runner
from lima_execution import firewall_rules


def canonical_firewall_rules():
    """Model the normalized output returned by `nft list ruleset`."""
    return firewall_rules().replace("priority 0", "priority filter")


def qualification_record(base):
    probe = {"target_ip": "192.168.5.2", "target_port": 443,
             "connect_errno": 1, "outcome": "blocked"}
    ipv4 = {name: "blocked" for name in (
        "host_loopback", "host_lan", "host_ssh", "hostagent_forward", "lan_gateway",
        "public_ipv4", "ipv4_dns", "other_instance")}
    isolation = {"ipv4": ipv4, "ipv6": "no_route", "firewall_rules": canonical_firewall_rules(),
                 "ipv6_detail": {"default_route_present": False, "route_table": ""},
                 "firewall_change_as_candidate_user": "denied"}
    boundary = {"probe_account_uid": 1000, "proxy_variable_names": [],
                "shared_mount_targets": [], "agent_socket_environment_present": False,
                "control_sockets_accessible_by_probe_user": []}
    checks = {
        "guest_profile": {"status": "passed", "evidence": {"uname": "Linux"}},
        "guest_boundary": {"status": "passed", "evidence": boundary},
        "guest_egress": {"status": "passed", "evidence": isolation},
        "other_guest_denied": {"status": "passed", "evidence": {
            "probe": probe, "second_guest_running": True}},
        "host_canary_denied": {"status": "passed", "evidence": {
        "probe": {**probe, "target_ip": "192.168.5.2"}, "canary_connections_accepted": 0}},
        "host_lan_canary_denied": {"status": "passed", "evidence": {
            "interface": "en0", "probe": {**probe, "target_ip": "192.168.1.20",
              "target_port": 54321, "interface": "en0"}, "canary_connections_accepted": 0}},
        "host_ssh_continuity": {"status": "passed", "evidence": {"fresh_ssh_exit": 0}},
        "bounded_cancellation": {"status": "passed", "evidence": {
            "host_process_group_reaped": True, "guest_process_containment": "exact_vm_teardown"}},
        "exact_teardown": {"status": "passed", "evidence": {"all_stopped_and_deleted": True}},
    }
    return {"schema": 2, "status": "qualified", "lima_version": runner.LIMA_VERSION,
            "trusted_base": base, "trusted_runner_head": base,
            "trusted_tools_sha256": runner.trusted_tool_hashes(), "checks": checks,
            "cleanup": {"status": "complete", "instances": ["guest-a", "guest-b"]},
            "guest_tools": {"guest-a": {"uname": "Linux"}, "guest-b": {"uname": "Linux"}},
            "direct_probes": isolation, "candidate_transferred": False,
            "candidate_code_executed": False}


class LimaLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / ("jarvis-issue214-" + "a" * 32)
        self.path.mkdir()
        self.record = {
            "name": self.path.name, "status": "Running", "dir": str(self.path),
            "sshAddress": "127.0.0.1",
            "config": {"vmType": "vz", "arch": "aarch64", "cpus": 4,
                       "memory": "8GiB", "disk": "40GiB", "plain": True,
                       "propagateProxyEnv": False, "mounts": None, "portForwards": None,
                       "images": [{"arch": "aarch64", "digest": "sha256:" + "a" * 64,
                                   "location": "https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img"}],
                       "ssh": {"forwardAgent": False, "forwardX11": False}},
        }
        self.run = runner.LimaRun("a" * 32)
        self.run.created = True
        self.run.started = True
        self.run.instance_dir = self.path

    def tearDown(self):
        self.temp.cleanup()

    @patch.object(runner, "run_host")
    def test_active_lan_ipv4_uses_default_interface_and_rejects_unsafe_addresses(self, command):
        command.side_effect = ["gateway: 192.168.1.1\ninterface: en0", "192.168.1.20"]
        self.assertEqual(runner.active_lan_ipv4(), ("en0", "192.168.1.20"))
        self.assertEqual(command.call_args_list[0].args[0], ["route", "-n", "get", "default"])
        self.assertEqual(command.call_args_list[1].args[0], ["ipconfig", "getifaddr", "en0"])

    @patch.object(runner, "run_host")
    def test_active_lan_ipv4_fails_closed_for_unsafe_or_ambiguous_discovery(self, command):
        for address in ("127.0.0.1", "169.254.1.2", "224.0.0.1", "0.0.0.0"):
            command.side_effect = ["interface: en0", address]
            with self.subTest(address=address), self.assertRaises(runner.ValidationError):
                runner.active_lan_ipv4()
        command.side_effect = ["interface: en0\ninterface: en1"]
        with self.assertRaises(runner.ValidationError):
            runner.active_lan_ipv4()

    @patch.object(runner, "run_host")
    @patch.object(runner, "instance_records")
    def test_cleanup_stops_then_deletes_only_exact_instance(self, records, command):
        records.side_effect = [[self.record], [{**self.record, "status": "Stopped"}], []]
        self.run.cleanup()
        self.assertEqual([call.args[0][1] for call in command.call_args_list],
                         ["stop", "delete"])
        self.assertFalse(self.run.created)

    @patch.object(runner, "instance_records", return_value=[])
    def test_cleanup_refuses_missing_or_ambiguous_identity(self, _records):
        with self.assertRaises(runner.LimaValidationError):
            self.run.cleanup()

    @patch.object(runner, "run_host")
    @patch.object(runner, "instance_records")
    def test_partial_start_failure_is_discovered_then_stopped_and_deleted(self, records, command):
        stopped = {**self.record, "status": "Stopped"}
        records.side_effect = [[], [stopped], [self.record], [stopped], []]
        command.side_effect = [None, runner.ValidationError("start timed out"), None, None]
        self.run.created = False
        self.run.instance_dir = None
        with self.assertRaises(runner.ValidationError):
            self.run.create()
        self.run.cleanup()
        self.assertEqual([call.args[0][1] for call in command.call_args_list],
                         ["create", "start", "stop", "delete"])

    @patch.object(runner, "run_host")
    @patch.object(runner, "instance_records", return_value=[])
    def test_create_timeout_with_no_discoverable_instance_is_reported_unsafe(self, _records, command):
        command.side_effect = runner.ValidationError("create timed out")
        self.run.created = False
        with self.assertRaises(runner.ValidationError):
            self.run.create()
        with self.assertRaisesRegex(runner.ValidationError, "uncertain"):
            self.run.cleanup()

    def test_stage1_launcher_refuses_candidate_execution(self):
        args = type("Args", (), {"enable_candidate_execution": False,
                                  "expected_base": "a" * 40, "expected_head": "b" * 40,
                                  "report": str(Path(self.temp.name) / "disabled.json")})()
        root = Path(self.temp.name) / "trusted-root"
        root.mkdir()
        with patch.object(runner, "trusted_root", return_value=root):
            with self.assertRaisesRegex(runner.ValidationError, "explicit Stage 2"):
                runner.run_validation(args)

    def test_explicit_opt_in_requires_qualification_report(self):
        args = type("Args", (), {"enable_candidate_execution": True,
                                  "qualification_report": None,
                                  "expected_base": "a" * 40, "expected_head": "b" * 40,
                                  "report": str(Path(self.temp.name) / "missing-qualification.json")})()
        root = Path(self.temp.name) / "trusted-root"
        root.mkdir()
        with patch.object(runner, "trusted_root", return_value=root):
            with self.assertRaisesRegex(runner.ValidationError, "qualification evidence"):
                runner.run_validation(args)

    def test_host_output_bound_is_enforced_during_process_write(self):
        with self.assertRaisesRegex(runner.ValidationError, "output exceeded"):
            runner.run_host([sys.executable, "-c", "print('x' * 1000000)"],
                            timeout=5, output_limit=1024)

    def test_host_command_keeps_successful_stderr_out_of_json_stdout(self):
        warning = "No instance found. Run `limactl create` to create an instance."
        code = "import sys; print(" + repr(warning) + ", file=sys.stderr)"
        stdout = runner.run_host([sys.executable, "-c", code], timeout=5, output_limit=4096)
        self.assertEqual(stdout, "")
        self.assertEqual(runner.parse_list_json(stdout), [])

    @patch.object(runner, "run_host", return_value=("", "unexpected warning"))
    def test_instance_list_rejects_unrecognized_stderr(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    @patch.object(runner, "run_host", return_value=("", 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."'))
    def test_instance_list_accepts_timestamped_empty_inventory_warning(self, _command):
        self.assertEqual(runner.instance_records(), [])

    @patch.object(runner, "run_host", return_value=("", 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."\nunexpected stderr'))
    def test_instance_list_rejects_expected_warning_with_extra_stderr(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    @patch.object(runner, "run_host", return_value=("malformed", 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."'))
    def test_instance_list_rejects_warning_with_nonempty_stdout(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    @patch.object(runner, "run_host", return_value=(" \n", 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."\n'))
    def test_instance_list_rejects_whitespace_only_stdout(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    @patch.object(runner, "run_host", return_value=("", 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."\n\n'))
    def test_instance_list_rejects_extra_blank_stderr_line(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    @patch.object(runner, "run_host", return_value=("", ' time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance." '))
    def test_instance_list_rejects_surrounding_warning_whitespace(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "unexpected stderr"):
            runner.instance_records()

    def test_run_host_return_stderr_preserves_raw_streams(self):
        warning = 'time="2026-10-27T23:54:33+01:00" level=warning msg="No instance found. Run `limactl create` to create an instance."'
        code = "import sys; sys.stdout.write(' \\n'); sys.stderr.write(" + repr(warning + "\n") + ")"
        self.assertEqual(runner.run_host([sys.executable, "-c", code], return_stderr=True),
                         (" \n", warning + "\n"))

    @patch.object(runner, "run_host", return_value=("malformed", ""))
    def test_instance_list_rejects_malformed_stdout(self, _command):
        with self.assertRaises(runner.LimaValidationError):
            runner.instance_records()

    @patch.object(runner, "run_host", side_effect=runner.ValidationError("trusted host command failed: limactl (exit 1)"))
    def test_instance_list_rejects_nonzero_command(self, _command):
        with self.assertRaisesRegex(runner.ValidationError, "exit 1"):
            runner.instance_records()

    def test_host_timeout_kills_process_group(self):
        with self.assertRaisesRegex(runner.ValidationError, "timed out"):
            runner.run_host([sys.executable, "-c", "import time; time.sleep(30)"],
                            timeout=0.1, output_limit=1024)

    def test_signal_handler_records_request_and_host_runner_reaps_command(self):
        runner.cancel_requested.clear()
        runner._interrupt(15, None)
        self.assertTrue(runner.cancel_requested.is_set())
        runner.cancel_requested.clear()

    def test_cancellation_during_blocking_host_command_kills_and_reaps_process_group(self):
        runner.cancel_requested.clear()
        marker = Path(self.temp.name) / "child.pid"
        code = (
            "import pathlib,subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
            f"pathlib.Path({str(marker)!r}).write_text(str(child.pid)); time.sleep(60)"
        )
        def request_cancel():
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline and not marker.exists():
                time.sleep(0.01)
            runner._interrupt(15, None)
        interrupter = threading.Thread(target=request_cancel)
        interrupter.start()
        try:
            with self.assertRaisesRegex(runner.InterruptedValidation, "process group reaped"):
                runner.run_host([sys.executable, "-c", code], timeout=10, output_limit=4096)
        finally:
            interrupter.join(timeout=5)
            runner.cancel_requested.clear()
        self.assertFalse(interrupter.is_alive())

    @patch.object(runner, "LimaRun")
    @patch.object(runner, "trusted_seed")
    @patch.object(runner, "trusted_pins", return_value=("24.22.0", "12.5.1",
                                                         "postgres:18.6@sha256:" + "a" * 64,
                                                         "sha512-" + "A" * 86 + "=="))
    @patch.object(runner, "verify_candidate_package_setup")
    @patch.object(runner, "verify_workspace")
    @patch.object(runner, "load_qualification_report", return_value={})
    @patch.object(runner, "verify_trusted_checkout")
    def test_interrupted_run_still_attempts_cleanup_for_both_vm_slots(
            self, checkout, _qualification, _workspace_check, _package_check,
            _pins, _seed, lima_run):
        root = Path(self.temp.name) / "trusted"
        workspace = Path(self.temp.name) / "candidate"
        root.mkdir()
        workspace.mkdir()
        checkout.return_value = root
        report_path = Path(self.temp.name) / "cancelled.json"
        args = type("Args", (), {"enable_candidate_execution": True,
                                  "qualification_report": str(Path(self.temp.name) / "qualification.json"),
                                  "expected_base": "a" * 40, "expected_head": "b" * 40,
                                  "workspace": str(workspace), "report": str(report_path)})()
        objects = []
        class FakeRun:
            def __init__(self, _run_id):
                self.ever_created = True
                self.created = True
                self.name = "fake-run"
                self.cleanup_calls = 0
                objects.append(self)

            def create(self):
                if self is objects[0]:
                    runner.cancel_requested.set()
                    raise runner.InterruptedValidation("signal cancellation")

            def cleanup(self):
                self.cleanup_calls += 1
                self.created = False

        lima_run.side_effect = FakeRun
        with patch.object(runner, "trusted_root", return_value=root), \
             patch.object(runner.tempfile, "gettempdir", return_value=self.temp.name):
            with self.assertRaisesRegex(runner.InterruptedValidation, "signal cancellation"):
                runner.run_validation(args)
        self.assertEqual(len(objects), 2)
        self.assertEqual([item.cleanup_calls for item in objects], [1, 1])
        self.assertEqual(json.loads(report_path.read_text())["cleanup"], "complete")
        self.assertFalse(runner.cancel_requested.is_set())

    def test_early_validation_failure_writes_sanitized_report(self):
        report = Path(self.temp.name) / "failure.json"
        args = type("Args", (), {
            "enable_candidate_execution": False,
            "expected_base": "a" * 40,
            "expected_head": "b" * 40,
            "report": str(report),
        })()
        root = Path(self.temp.name) / "trusted-root"
        root.mkdir()
        with patch.object(runner, "trusted_root", return_value=root):
            with self.assertRaisesRegex(runner.ValidationError, "explicit Stage 2"):
                runner.run_validation(args)
        data = json.loads(report.read_text())
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["cleanup"], "not_started")
        self.assertEqual(data["error_type"], "ValidationError")

    def test_existing_report_is_preserved_on_early_failure(self):
        report = Path(self.temp.name) / "existing.json"
        report.write_text('{"operator_note":"preserve"}\n')
        args = type("Args", (), {"enable_candidate_execution": False,
                                  "expected_base": "a" * 40, "expected_head": "b" * 40,
                                  "report": str(report)})()
        root = Path(self.temp.name) / "trusted-root"
        root.mkdir()
        with patch.object(runner, "trusted_root", return_value=root):
            with self.assertRaises(runner.ValidationError):
                runner.run_validation(args)
        self.assertEqual(json.loads(report.read_text()), {"operator_note": "preserve"})

    def test_qualification_report_is_bound_to_trusted_base_and_launcher_and_outside_candidate(self):
        workspace = Path(self.temp.name) / "candidate"
        trusted = Path(self.temp.name) / "trusted"
        workspace.mkdir()
        trusted.mkdir()
        report_path = Path(self.temp.name) / "qualification.json"
        payload = qualification_record("a" * 40)
        report_path.write_text(json.dumps(payload))
        report_path.chmod(0o600)
        self.assertEqual(runner.load_qualification_report(
            report_path, workspace=workspace, trusted_root=trusted, expected_base="a" * 40), payload)
        payload["checks"].pop("host_lan_canary_denied")
        report_path.write_text(json.dumps(payload))
        with self.assertRaisesRegex(runner.ValidationError, "trusted base and launcher"):
            runner.load_qualification_report(
                report_path, workspace=workspace, trusted_root=trusted, expected_base="a" * 40)
        payload = qualification_record("a" * 40)
        payload["checks"]["host_lan_canary_denied"]["evidence"]["canary_connections_accepted"] = 1
        report_path.write_text(json.dumps(payload))
        with self.assertRaisesRegex(
                runner.ValidationError,
                "both direct canary probes, default-drop firewall, and zero accepts are required"):
            runner.load_qualification_report(
                report_path, workspace=workspace, trusted_root=trusted, expected_base="a" * 40)
        payload = qualification_record("a" * 40)
        payload["trusted_runner_head"] = "b" * 40
        report_path.write_text(json.dumps(payload))
        with self.assertRaisesRegex(runner.ValidationError, "trusted base and launcher"):
            runner.load_qualification_report(
                report_path, workspace=workspace, trusted_root=trusted, expected_base="a" * 40)
        (workspace / "qualification.json").write_text(json.dumps(payload))
        with self.assertRaisesRegex(runner.ValidationError, "outside candidate"):
            runner.load_qualification_report(
                workspace / "qualification.json", workspace=workspace,
                trusted_root=trusted, expected_base="a" * 40)

    def test_qualification_report_rejects_boolean_only_proof(self):
        workspace = Path(self.temp.name) / "candidate"
        trusted = Path(self.temp.name) / "trusted"
        workspace.mkdir()
        trusted.mkdir()
        report = Path(self.temp.name) / "boolean-only.json"
        payload = {"status": "qualified", "lima_version": runner.LIMA_VERSION,
                   "trusted_base": "a" * 40, "trusted_runner_head": "a" * 40,
                   "trusted_tools_sha256": runner.trusted_tool_hashes(),
                   **{key: True for key in ("trusted_launcher", "host_lan_ipv4_denied",
                                             "ipv6_state_proven", "other_run_denied",
                                             "host_control_denied", "snapshot_integrity",
                                             "bounded_cancellation", "exact_cleanup")}}
        report.write_text(json.dumps(payload))
        report.chmod(0o600)
        with self.assertRaisesRegex(runner.ValidationError, "trusted base and launcher"):
            runner.load_qualification_report(report, workspace=workspace,
                                             trusted_root=trusted, expected_base="a" * 40)

    def test_qualification_mode_rejects_candidate_inputs_before_runner(self):
        args = type("Args", (), {"qualify_only": True, "enable_candidate_execution": False,
                                  "qualification_report": None, "workspace": "/candidate",
                                  "expected_base": "a" * 40,
                                  "report": str(Path(self.temp.name) / "qualify.json")})()
        with self.assertRaisesRegex(runner.ValidationError, "cannot accept candidate"):
            runner.run_validation(args)

    def test_qualification_failure_never_creates_a_report(self):
        report = Path(self.temp.name) / "failed-qualification.json"
        args = type("Args", (), {"expected_base": "a" * 40, "report": str(report)})()
        with patch.object(runner, "verify_trusted_checkout", side_effect=runner.ValidationError("dirty")):
            with self.assertRaisesRegex(runner.ValidationError, "dirty"):
                runner.run_qualification(args)
        self.assertFalse(report.exists())

    def test_qualification_report_generation_requires_observed_checks_and_exact_teardown(self):
        sample = qualification_record("a" * 40)
        generated = runner.qualification_report_payload(
            base=sample["trusted_base"], hashes=sample["trusted_tools_sha256"],
            guest_tools=sample["guest_tools"], probes=sample["direct_probes"],
            checks=sample["checks"], cleanup_instances=sample["cleanup"]["instances"],
        )
        destination = Path(self.temp.name) / "generated-qualification.json"
        root = Path(self.temp.name) / "trusted-root"
        root.mkdir()
        runner.write_report(destination, generated, root)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(destination.read_text()), generated)
        failed_checks = {**sample["checks"], "exact_teardown": {
            "status": "passed", "evidence": {"all_stopped_and_deleted": False}}}
        with self.assertRaisesRegex(runner.ValidationError, "exact cleanup"):
            runner.qualification_report_payload(
                base=sample["trusted_base"], hashes=sample["trusted_tools_sha256"],
                guest_tools=sample["guest_tools"], probes=sample["direct_probes"],
                checks=failed_checks, cleanup_instances=sample["cleanup"]["instances"],
            )

    def test_package_preflight_rejects_hooks_nested_configs_and_manifest_symlinks(self):
        trusted = Path(self.temp.name) / "trusted"
        candidate = Path(self.temp.name) / "candidate"
        trusted.mkdir()
        candidate.mkdir()
        package = {"packageManager": "pnpm@12.5.1", "engines": {"node": ">=24"},
                   "scripts": {"test": "node --test"}}
        for root in (trusted, candidate):
            (root / "package.json").write_text(json.dumps(package))
            (root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n")
            (root / "pnpm-workspace.yaml").write_text("packages: []\n")
        runner.verify_candidate_package_setup(trusted, candidate)
        package["scripts"]["pretest"] = "unsafe"
        (candidate / "package.json").write_text(json.dumps(package))
        with self.assertRaisesRegex(runner.ValidationError, "lifecycle"):
            runner.verify_candidate_package_setup(trusted, candidate)
        package["scripts"].pop("pretest")
        (candidate / "package.json").write_text(json.dumps(package))
        (candidate / "apps/api").mkdir(parents=True)
        (candidate / "apps/api/package.json").symlink_to(candidate / "package.json")
        with self.assertRaisesRegex(runner.ValidationError, "regular file"):
            runner.verify_candidate_package_setup(trusted, candidate)
        (candidate / "apps/api/package.json").unlink()
        (candidate / "apps/api/.npmrc").write_text("registry=https://attacker.invalid\n")
        with self.assertRaisesRegex(runner.ValidationError, "unsupported package-manager"):
            runner.verify_candidate_package_setup(trusted, candidate)

    def test_trusted_tool_pins_include_lockfile_authenticated_pnpm_archive(self):
        root = Path(self.temp.name)
        (root / "package.json").write_text(json.dumps({"packageManager": "pnpm@12.5.1"}))
        (root / ".nvmrc").write_text("24.22.0\n")
        (root / "infra/colima").mkdir(parents=True)
        (root / "infra/colima/versions.env").write_text(
            "POSTGRES_IMAGE=postgres:18.6@sha256:" + "a" * 64 + "\nPOSTGRES_PLATFORM=linux/arm64\n")
        (root / "pnpm-lock.yaml").write_text(
            "  pnpm@12.5.1:\n    resolution: {integrity: sha512-" + "A" * 86 + "==}\n")
        self.assertEqual(runner.trusted_pins(root),
                         ("24.22.0", "12.5.1", "postgres:18.6@sha256:" + "a" * 64,
                           "sha512-" + "A" * 86 + "=="))

    @patch.object(runner.fcntl, "flock", side_effect=BlockingIOError)
    @patch.object(runner, "trusted_pins", return_value=("24.22.0", "12.5.1",
                                                         "postgres:18.6@sha256:" + "a" * 64,
                                                         "sha512-" + "A" * 86 + "=="))
    @patch.object(runner, "verify_candidate_package_setup")
    @patch.object(runner, "verify_workspace")
    @patch.object(runner, "load_qualification_report", return_value={})
    @patch.object(runner, "verify_trusted_checkout")
    def test_trusted_postgres_pin_is_retained_in_failure_report_state(
            self, checkout, qualification, workspace_check, package_check, pins, flock):
        root = Path(self.temp.name) / "trusted"
        workspace = Path(self.temp.name) / "candidate"
        root.mkdir()
        workspace.mkdir()
        checkout.return_value = root
        report_path = Path(self.temp.name) / "report.json"
        args = type("Args", (), {"enable_candidate_execution": True,
                                  "qualification_report": str(Path(self.temp.name) / "qualification.json"),
                                  "expected_base": "a" * 40, "expected_head": "b" * 40,
                                  "workspace": str(workspace), "report": str(report_path)})()
        report = {"schema": 1, "status": "failed", "cleanup": "not_started"}
        with patch.object(runner.tempfile, "gettempdir", return_value=self.temp.name):
            with self.assertRaisesRegex(runner.ValidationError, "another issue-214"):
                runner._run_validation_impl(args, report, report_path, root)
        self.assertEqual(report["postgres_image"], "postgres:18.6@sha256:" + "a" * 64)
        self.assertEqual(json.loads(report_path.read_text())["postgres_image"], report["postgres_image"])

    @patch.object(runner.fcntl, "flock", side_effect=BlockingIOError)
    @patch.object(runner, "trusted_pins", return_value=("24.22.0", "12.5.1",
                                                         "postgres:18@sha256:" + "a" * 64,
                                                         "sha512-" + "A" * 86 + "=="))
    @patch.object(runner, "verify_candidate_package_setup")
    @patch.object(runner, "verify_workspace")
    @patch.object(runner, "verify_trusted_checkout")
    @patch.object(runner, "trusted_root")
    def test_lock_conflict_writes_failure_report_without_uninitialized_cleanup(
            self, trusted_root, verify_checkout, verify_workspace, verify_package, _pins, _flock):
        root = Path(self.temp.name) / "trusted"
        root.mkdir()
        workspace = Path(self.temp.name) / "workspace"
        workspace.mkdir()
        trusted_root.return_value = root
        verify_checkout.return_value = root
        report = Path(self.temp.name) / "result.json"
        args = type("Args", (), {
            "enable_candidate_execution": True,
            "qualification_report": str(Path(self.temp.name) / "qualification.json"),
            "expected_base": "a" * 40, "expected_head": "b" * 40,
            "workspace": str(workspace), "report": str(report),
        })()
        qualification = qualification_record("a" * 40)
        Path(args.qualification_report).write_text(json.dumps(qualification))
        Path(args.qualification_report).chmod(0o600)
        with patch.object(runner.tempfile, "gettempdir", return_value=self.temp.name):
            with self.assertRaisesRegex(runner.ValidationError, "another issue-214"):
                runner.run_validation(args)
        data = json.loads(report.read_text())
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["cleanup"], "not_required")


if __name__ == "__main__":
    unittest.main()
