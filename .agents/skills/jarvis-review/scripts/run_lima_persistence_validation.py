#!/usr/bin/env python3
"""Run the issue-214 persistence suite in a fresh, isolated ARM64 Lima guest.

Run only from a clean trusted-base checkout after this launcher is part of that
base. Candidate repository code is transferred as data and executed only in the
unprivileged guest. This script never invokes candidate programs on macOS.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

from lima_execution import (
    DISK_GIB,
    HOST_SSH_SOURCE,
    INSTANCE_PREFIX,
    MAX_SETUP_SECONDS,
    MAX_TEST_SECONDS,
    MAX_OUTPUT_BYTES,
    MEMORY_GIB,
    LimaValidationError,
    candidate_test_command,
    create_arguments,
    instance_name,
    parse_list_json,
    teardown_identity,
    validate_instance,
    validate_firewall_rules,
)


SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
LIMA_VERSION = "2.2.1"
# Candidate execution remains disabled unless separately opted into and bound
# to a successful trusted-base qualification report.
COMMAND_TIMEOUT = 120
GUEST_CONTROLLER = Path(__file__).with_name("lima_guest_controller.py")
GUEST_PROFILE_HELPER = Path(__file__).with_name("lima_execution.py")
WORKSPACE_HELPER = Path(__file__).with_name("prepare_validation_workspace.py")
GUEST_WORKSPACE_HELPER = Path(__file__).with_name("prepare_validation_workspace.py")


class ValidationError(Exception):
    pass


class InterruptedValidation(ValidationError):
    pass


cancel_requested = threading.Event()


def _interrupt(signum, _frame):
    # Signal handlers only record intent. The command supervisor performs
    # process-group termination/reaping in ordinary control flow.
    cancel_requested.set()


def trusted_root() -> Path:
    source = Path(__file__).resolve()
    if len(source.parents) > 4:
        return source.parents[4]
    # Makes the pure bootstrap gate/report path testable when helpers are copied
    # to a disposable test directory; the launcher's real checkout path remains
    # the fixed repository-relative parent above.
    return source.parent


def host_environment() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", str(Path.home())),
        "TMPDIR": os.environ.get("TMPDIR", "/private/var/tmp"),
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
    }


def run_host(command: list[str], *, timeout=COMMAND_TIMEOUT, cwd=None, input_text=None,
             output_limit=MAX_OUTPUT_BYTES) -> str:
    # Drain into bounded memory so noisy subprocesses cannot accumulate output;
    # unlike RLIMIT_FSIZE this does not cap
    # unrelated files created by the command (such as the trusted seed archive).
    process = None
    captured = bytearray()
    overflow = threading.Event()
    write_error = []
    try:
        process = subprocess.Popen(
            command, cwd=cwd, env=host_environment(),
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )

        def drain():
            while True:
                chunk = process.stdout.read(65536)
                if not chunk:
                    return
                if len(captured) + len(chunk) > output_limit:
                    overflow.set()
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    continue
                captured.extend(chunk)

        def feed():
            try:
                process.stdin.write(input_text.encode())
                process.stdin.close()
            except (BrokenPipeError, OSError) as error:
                write_error.append(error)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        writer = None
        if input_text is not None:
            writer = threading.Thread(target=feed, daemon=True)
            writer.start()
        deadline = time.monotonic() + timeout
        while True:
            if cancel_requested.is_set():
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    reader.join(timeout=2)
                    if writer is not None:
                        writer.join(timeout=2)
                    raise InterruptedValidation("validation cancelled; host process group reaped")
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                error = subprocess.TimeoutExpired(command, timeout)
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                reader.join(timeout=2)
                if writer is not None:
                    writer.join(timeout=2)
                raise ValidationError(f"trusted host command timed out: {Path(command[0]).name}") from error
            try:
                process.wait(timeout=min(0.1, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if writer is not None:
            writer.join(timeout=2)
        reader.join(timeout=2)
        if reader.is_alive():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise ValidationError("trusted host command left an output-producing process")
        if overflow.is_set():
            raise ValidationError("trusted host command output exceeded the safety limit")
        if write_error and process.returncode == 0:
            raise ValidationError("trusted host command input could not be delivered")
        text = captured.decode("utf-8", errors="replace")
    except BaseException:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if "reader" in locals():
            reader.join(timeout=2)
        if "writer" in locals() and writer is not None:
            writer.join(timeout=2)
        raise
    finally:
        if process is not None:
            if process.stdout is not None:
                process.stdout.close()
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
    if process.returncode:
        raise ValidationError(f"trusted host command failed: {Path(command[0]).name} (exit {process.returncode})")
    return text.strip()


def active_lan_ipv4() -> tuple[str, str]:
    """Discover the active default-route interface's assigned IPv4, fail closed."""
    route = run_host(["route", "-n", "get", "default"], timeout=10, output_limit=4096)
    interfaces = re.findall(r"^\s*interface:\s*([A-Za-z0-9_.-]+)\s*$", route, re.MULTILINE)
    if len(interfaces) != 1:
        raise ValidationError("active default-route interface could not be identified safely")
    interface = interfaces[0]
    address_text = run_host(["ipconfig", "getifaddr", interface], timeout=10, output_limit=1024)
    try:
        address = ipaddress.ip_address(address_text)
    except ValueError as error:
        raise ValidationError("active interface did not provide a valid IPv4 address") from error
    if (not isinstance(address, ipaddress.IPv4Address) or address.is_loopback
            or address.is_link_local or address.is_multicast or address.is_unspecified):
        raise ValidationError("active interface IPv4 is not a safe LAN probe target")
    return interface, str(address)


def git(root: Path, *args: str) -> str:
    return run_host([
        "git", "-c", f"core.hooksPath={os.devnull}", "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false", "-C", str(root), *args,
    ], cwd=root, output_limit=2 * 1024 * 1024)


def verify_trusted_checkout(expected_base: str) -> Path:
    root = trusted_root().resolve(strict=True)
    if not SHA_RE.fullmatch(expected_base):
        raise ValidationError("expected base must be a full lowercase commit ID")
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve(strict=True) != root:
        raise ValidationError("trusted launcher is not at the repository root")
    if git(root, "rev-parse", "HEAD") != expected_base:
        raise ValidationError("trusted runner checkout HEAD differs from expected base")
    if git(root, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"):
        raise ValidationError("trusted runner checkout has staged, tracked, or untracked drift")
    for path in (GUEST_CONTROLLER, GUEST_PROFILE_HELPER, WORKSPACE_HELPER):
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValidationError("trusted runner helper escaped its checkout")
    version = run_host(["limactl", "--version"], output_limit=4096)
    if version != f"limactl version {LIMA_VERSION}":
        raise ValidationError("Lima version does not match the qualified host version")
    return root


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"trusted or candidate package manifest is missing/invalid: {path.name}") from error
    if not isinstance(value, dict):
        raise ValidationError(f"package manifest is not an object: {path.name}")
    return value


def trusted_pins(root: Path) -> tuple[str, str, str, str]:
    package = read_json(root / "package.json")
    manager = package.get("packageManager", "")
    match = re.fullmatch(r"pnpm@([0-9]+\.[0-9]+\.[0-9]+)", manager)
    if not match:
        raise ValidationError("trusted packageManager pin is invalid")
    node = (root / ".nvmrc").read_text(encoding="ascii").strip()
    if not re.fullmatch(r"24\.[0-9]+\.[0-9]+", node):
        raise ValidationError("trusted Node.js pin is invalid")
    pins = {}
    for line in (root / "infra/colima/versions.env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            pins[key] = value.strip().strip("\"'")
    image = pins.get("POSTGRES_IMAGE", "")
    if (not re.fullmatch(r"postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", image)
            or pins.get("POSTGRES_PLATFORM") != "linux/arm64"):
        raise ValidationError("trusted PostgreSQL digest/platform is invalid")
    pnpm_version = match.group(1)
    lock = (root / "pnpm-lock.yaml").read_text(encoding="utf-8")
    lock_match = re.search(
        rf"(?m)^  pnpm@{re.escape(pnpm_version)}:\n    resolution: \{{integrity: (sha512-[A-Za-z0-9+/=]+)\}}$",
        lock,
    )
    if not lock_match:
        raise ValidationError("trusted pnpm package integrity pin is missing")
    return node, pnpm_version, image, lock_match.group(1)


FORBIDDEN_HOOKS = {
    "preinstall", "install", "postinstall", "prepare", "pretest", "posttest",
    "prebuild", "postbuild", "prestart", "poststart",
}


def verify_candidate_package_setup(root: Path, workspace: Path) -> None:
    """Inspect package data only; demand trusted lock/workspace/config/script pins."""
    trusted_root = read_json(root / "package.json")
    candidate_root = read_json(workspace / "package.json")
    if (candidate_root.get("packageManager") != trusted_root.get("packageManager")
            or candidate_root.get("engines") != trusted_root.get("engines")):
        raise ValidationError("candidate package manager or Node engine differs from trusted base")
    for relative in ("pnpm-lock.yaml", "pnpm-workspace.yaml"):
        trusted, candidate = root / relative, workspace / relative
        if (trusted.is_symlink() or candidate.is_symlink() or not trusted.is_file()
                or not candidate.is_file() or trusted.read_bytes() != candidate.read_bytes()):
            raise ValidationError(f"candidate {relative} differs from trusted dependency/workspace input")
    for relative in (".npmrc",):
        trusted, candidate = root / relative, workspace / relative
        if candidate.exists() or candidate.is_symlink():
            if (candidate.is_symlink() or not candidate.is_file() or not trusted.is_file()
                    or candidate.read_bytes() != trusted.read_bytes()):
                raise ValidationError("candidate npm configuration is unsupported")
    for path in (workspace / ".pnpmfile.cjs", workspace / ".pnpmfile.js", workspace / ".pnpmfile.mjs",
                 *workspace.glob("apps/*/.npmrc"), *workspace.glob("packages/*/.npmrc")):
        if path.exists() or path.is_symlink():
            raise ValidationError("candidate contains an unsupported package-manager hook/configuration")
    for candidate_path in [workspace / "package.json", *workspace.glob("apps/*/package.json"),
                            *workspace.glob("packages/*/package.json")]:
        if candidate_path.is_symlink() or not candidate_path.is_file():
            raise ValidationError("candidate package manifest must be a regular file")
        relative = candidate_path.relative_to(workspace)
        trusted_path = root / relative
        candidate = read_json(candidate_path)
        trusted = read_json(trusted_path)
        if not isinstance(candidate.get("scripts", {}), dict):
            raise ValidationError("candidate scripts must be a JSON object")
        if FORBIDDEN_HOOKS.intersection(candidate.get("scripts", {})):
            raise ValidationError("candidate lifecycle scripts are not allowed")
        if candidate.get("scripts", {}).get("test") != trusted.get("scripts", {}).get("test"):
            raise ValidationError(f"candidate test command changed: {relative}")


def verify_workspace(workspace: Path, base: str, head: str) -> dict:
    output = run_host([
        sys.executable, str(WORKSPACE_HELPER), "verify", "--workspace", str(workspace),
    ], timeout=120, cwd=trusted_root(), output_limit=2 * 1024 * 1024)
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise ValidationError("trusted workspace verifier returned invalid JSON") from error
    source = result.get("source", {}) if isinstance(result, dict) else {}
    if result.get("status") != "verified" or source.get("base") != base or source.get("head") != head:
        raise ValidationError("validation snapshot does not match the requested exact revisions")
    return source


def instance_records() -> list[dict]:
    return parse_list_json(run_host(["limactl", "list", "--json"], timeout=30, output_limit=4 * 1024 * 1024))


def get_instance(name: str) -> dict:
    matches = [record for record in instance_records() if record.get("name") == name]
    if len(matches) != 1:
        raise ValidationError("run instance is missing or ambiguous")
    return matches[0]


class HostCanary:
    """A temporary listener bound to one explicitly selected host endpoint."""
    def __init__(self, bind_address: str):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.bind((bind_address, 0))
        except OSError as error:
            self.socket.close()
            raise ValidationError("host canary endpoint is not locally bindable; isolation probe cannot be qualified") from error
        self.socket.listen(4)
        self.socket.settimeout(0.2)
        self.port = self.socket.getsockname()[1]
        self.stopping = threading.Event()
        self.accepted = 0
        self.accepted_lock = threading.Lock()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self):
        while not self.stopping.is_set():
            try:
                client, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self.accepted_lock:
                self.accepted += 1
            client.close()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.stopping.set()
        self.socket.close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise ValidationError("host canary listener did not stop")


class LimaRun:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self.name = instance_name(run_id)
        self.instance_dir: Path | None = None
        self.created = False
        self.started = False
        self.creation_uncertain = False
        self.ever_created = False

    def create(self):
        if any(record.get("name") == self.name for record in instance_records()):
            raise ValidationError("unique Lima run name already exists; refusing reuse")
        self.creation_uncertain = True
        try:
            run_host(["limactl", *create_arguments(self.name)], timeout=180, output_limit=8 * 1024 * 1024)
        except ValidationError:
            # A timed-out/failed create may still have created this unique name.
            self.creation_uncertain = True
            try:
                records = instance_records()
                if any(record.get("name") == self.name for record in records):
                    record = get_instance(self.name)
                    self.instance_dir = validate_instance(record, self.name, require_running=False)
                    self.created = True
                    self.ever_created = True
            except Exception:
                pass
            raise
        record = get_instance(self.name)
        self.instance_dir = validate_instance(record, self.name, require_running=False)
        self.created = True
        self.ever_created = True
        self.creation_uncertain = False
        run_host(["limactl", "start", "--tty=false", self.name], timeout=180,
                 output_limit=8 * 1024 * 1024)
        self.started = True
        record = get_instance(self.name)
        validate_instance(record, self.name, expected_dir=self.instance_dir)

    def shell(self, *args: str, timeout=COMMAND_TIMEOUT, output_limit=MAX_OUTPUT_BYTES, input_text=None) -> str:
        return run_host(["limactl", "shell", "--workdir", "/var/tmp", self.name, "--", *args],
                        timeout=timeout, input_text=input_text, output_limit=output_limit)

    def copy_to_guest(self, source: Path, destination: str, *, recursive=False, timeout=180):
        command = ["limactl", "copy", "--backend=scp"]
        if recursive:
            command.append("--recursive")
        command.extend([str(source), f"{self.name}:{destination}"])
        run_host(command, timeout=timeout, output_limit=2 * 1024 * 1024)

    def verify(self, *, running=True):
        if not self.created or self.instance_dir is None:
            raise ValidationError("run instance has no established identity")
        validate_instance(get_instance(self.name), self.name, expected_dir=self.instance_dir,
                          require_running=running)

    def cleanup(self):
        if not self.created:
            if self.creation_uncertain:
                raise ValidationError("create outcome is uncertain; exact instance cleanup cannot be proven")
            return
        record = teardown_identity(instance_records(), self.name, self.instance_dir)
        if record.get("status") not in {"Running", "Stopped"}:
            raise ValidationError("Lima instance state is uncertain; refusing teardown")
        if record.get("status") == "Running":
            run_host(["limactl", "stop", "--tty=false", self.name], timeout=120,
                     output_limit=8 * 1024 * 1024)
        stopped = get_instance(self.name)
        validate_instance(stopped, self.name, expected_dir=self.instance_dir, require_running=False)
        if stopped.get("status") != "Stopped":
            raise ValidationError("exact Lima instance did not reach Stopped state; refusing delete")
        run_host(["limactl", "delete", "--tty=false", self.name], timeout=120,
                 output_limit=8 * 1024 * 1024)
        if any(record.get("name") == self.name for record in instance_records()):
            raise ValidationError("exact run instance remains after deletion")
        self.created = False
        self.started = False
        self.creation_uncertain = False


def guest_action(run: LimaRun, controller: str, action: str, args: list[str] = (), *, timeout=120) -> dict:
    output = run.shell("sudo", "/usr/bin/python3", controller, action, *args,
                       timeout=timeout, output_limit=4 * 1024 * 1024)
    lines = [line for line in output.splitlines() if line.strip()]
    try:
        result = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise ValidationError("trusted guest controller returned invalid evidence") from error
    if not isinstance(result, dict) or result.get("status") == "failed":
        raise ValidationError("trusted guest controller rejected the operation")
    return result


def trusted_seed(root: Path, base: str, destination: Path):
    paths_output = git(root, "ls-tree", "-r", "--name-only", base)
    paths = [line for line in paths_output.splitlines() if re.fullmatch(
        r"(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|"
        r"apps/[^/]+/package\.json|packages/[^/]+/package\.json)", line,
    )]
    if not {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"}.issubset(paths):
        raise ValidationError("trusted base package seed is incomplete")
    run_host(["git", "-c", f"core.hooksPath={os.devnull}", "-c", "core.fsmonitor=false",
              "-C", str(root), "archive", "--format=tar", f"--output={destination}", base, *paths],
             timeout=120, cwd=root, output_limit=4096)


def write_report(path: Path, report: dict, root: Path):
    destination = path.expanduser().resolve(strict=False)
    if destination == root or destination.is_relative_to(root):
        raise ValidationError("report path must be outside the source checkout")
    if not destination.parent.is_dir() or destination.exists() or destination.is_symlink():
        raise ValidationError("report destination must be a new file in an existing directory")
    data = json.dumps(report, sort_keys=True, indent=2) + "\n"
    temporary = destination.with_name(destination.name + ".tmp-" + secrets.token_hex(4))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def trusted_tool_hashes() -> dict[str, str]:
    paths = {
        "host_launcher": Path(__file__),
        "guest_controller": GUEST_CONTROLLER,
        "lima_profile": GUEST_PROFILE_HELPER,
        "workspace_verifier": WORKSPACE_HELPER,
    }
    result = {}
    for name, path in paths.items():
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise ValidationError("trusted Stage 2 tool is not a regular file")
        result[name] = hashlib.sha256(resolved.read_bytes()).hexdigest()
    return result


def validate_canary_evidence(checks: dict) -> None:
    """Require two distinct blocked canaries and the observed default-drop policy."""
    try:
        isolation = checks["guest_egress"]["evidence"]
        rules = isolation["firewall_rules"]
        validate_firewall_rules(rules)
        endpoint = checks["host_canary_denied"]["evidence"]
        lan = checks["host_lan_canary_denied"]["evidence"]
        endpoint_probe = endpoint["probe"]
        lan_probe = lan["probe"]
        endpoint_ip = ipaddress.ip_address(endpoint_probe["target_ip"])
        lan_ip = ipaddress.ip_address(lan_probe["target_ip"])
        if (endpoint_probe["outcome"] != "blocked" or endpoint.get("canary_connections_accepted") != 0
                or lan_probe["outcome"] != "blocked" or lan.get("canary_connections_accepted") != 0
                or not isinstance(endpoint_ip, ipaddress.IPv4Address)
                or not isinstance(lan_ip, ipaddress.IPv4Address)
                or str(endpoint_ip) != HOST_SSH_SOURCE or endpoint_ip == lan_ip
                or lan_probe.get("interface") != lan.get("interface")
                or not re.fullmatch(r"[A-Za-z0-9_.-]+", lan["interface"])
                or lan_ip.is_loopback or lan_ip.is_link_local or lan_ip.is_multicast or lan_ip.is_unspecified
                or not isinstance(lan_probe.get("target_port"), int)
                or not 1 <= lan_probe["target_port"] <= 65535):
            raise ValueError
    except (KeyError, TypeError, ValueError, LimaValidationError) as error:
        raise ValidationError("both direct canary probes, default-drop firewall, and zero accepts are required") from error


def load_qualification_report(path: Path, *, workspace: Path, trusted_root: Path,
                              expected_base: str) -> dict:
    if path.is_symlink():
        raise ValidationError("Stage 2 qualification report cannot be a symlink")
    source = path.resolve(strict=True)
    if (source == workspace or source.is_relative_to(workspace)
            or workspace.is_relative_to(source) or source == trusted_root
            or source.is_relative_to(trusted_root)):
        raise ValidationError("Stage 2 qualification report must be outside candidate and trusted checkouts")
    info = source.stat()
    if (not source.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise ValidationError("Stage 2 qualification report must be an operator-owned protected regular file")
    try:
        qualification = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError("Stage 2 qualification report is missing or invalid") from error
    expected_tool_hashes = trusted_tool_hashes()
    checks = qualification.get("checks") if isinstance(qualification, dict) else None
    required_checks = {
        "guest_profile", "guest_boundary", "guest_egress", "other_guest_denied",
        "host_canary_denied", "host_lan_canary_denied", "host_ssh_continuity", "bounded_cancellation", "exact_teardown",
    }
    if (not isinstance(qualification, dict) or qualification.get("schema") != 2
            or qualification.get("status") != "qualified"
            or qualification.get("lima_version") != LIMA_VERSION
            or qualification.get("trusted_base") != expected_base
            or qualification.get("trusted_runner_head") != expected_base
            or qualification.get("trusted_tools_sha256") != expected_tool_hashes
            or not isinstance(checks, dict) or not required_checks.issubset(checks)
            or any(not isinstance(checks[key], dict) or checks[key].get("status") != "passed"
                   or not isinstance(checks[key].get("evidence"), dict)
                   or not checks[key].get("evidence") for key in required_checks)
            or not isinstance(qualification.get("cleanup"), dict)
            or qualification["cleanup"].get("status") != "complete"
            or not isinstance(qualification.get("guest_tools"), dict)
            or not isinstance(qualification.get("direct_probes"), dict)
            or qualification.get("candidate_transferred") is not False
            or qualification.get("candidate_code_executed") is not False):
        raise ValidationError("Stage 2 qualification report does not prove this trusted base and launcher")
    validate_canary_evidence(checks)
    boundary = checks["guest_boundary"]["evidence"]
    isolation = checks["guest_egress"]["evidence"]
    other_guest = checks["other_guest_denied"]["evidence"]
    host_canary = checks["host_canary_denied"]["evidence"]
    lan_canary = checks["host_lan_canary_denied"]["evidence"]
    lan_probe = lan_canary.get("probe") if isinstance(lan_canary, dict) else None
    try:
        lan_probe_ip = ipaddress.ip_address(lan_probe.get("target_ip"))
    except (AttributeError, TypeError, ValueError):
        lan_probe_ip = None
    required_ipv4 = {"host_loopback", "host_lan", "host_ssh", "hostagent_forward", "lan_gateway",
                     "public_ipv4", "ipv4_dns", "other_instance"}
    if (not isinstance(boundary, dict) or boundary.get("probe_account_uid", 0) <= 0
            or boundary.get("proxy_variable_names") or boundary.get("shared_mount_targets")
            or boundary.get("agent_socket_environment_present")
            or boundary.get("control_sockets_accessible_by_probe_user")
            or not isinstance(isolation, dict)
            or not isinstance(isolation.get("ipv4"), dict)
            or not required_ipv4.issubset(isolation["ipv4"])
            or any(isolation["ipv4"].get(key) != "blocked" for key in required_ipv4)
            or isolation.get("firewall_change_as_candidate_user") != "denied"
            or isolation.get("ipv6") not in {"blocked", "no_route"}
            or not isinstance(isolation.get("ipv6_detail"), dict)
            or not isinstance(other_guest, dict)
            or not isinstance(other_guest.get("probe"), dict)
            or other_guest["probe"].get("outcome") != "blocked"
            or other_guest.get("second_guest_running") is not True
            or not isinstance(host_canary, dict)
            or not isinstance(host_canary.get("probe"), dict)
            or host_canary["probe"].get("outcome") != "blocked"
            or host_canary.get("canary_connections_accepted") != 0
            or not isinstance(lan_canary, dict)
            or not isinstance(lan_canary.get("probe"), dict)
            or lan_canary["probe"].get("outcome") != "blocked"
            or lan_canary.get("canary_connections_accepted") != 0
            or lan_canary.get("interface") != lan_canary["probe"].get("interface")
            or not isinstance(lan_probe_ip, ipaddress.IPv4Address)
            or lan_probe_ip.is_loopback or lan_probe_ip.is_link_local
            or lan_probe_ip.is_multicast or lan_probe_ip.is_unspecified
            or str(lan_probe_ip) == HOST_SSH_SOURCE
            or not isinstance(lan_probe.get("target_port"), int)
            or not 1 <= lan_probe["target_port"] <= 65535
            or not isinstance(lan_canary.get("interface"), str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", lan_canary["interface"])
            or not isinstance(checks["host_ssh_continuity"]["evidence"], dict)
            or checks["host_ssh_continuity"]["evidence"].get("fresh_ssh_exit") != 0
            or not checks["bounded_cancellation"]["evidence"].get("host_process_group_reaped")
            or checks["bounded_cancellation"]["evidence"].get("guest_process_containment")
            != "exact_vm_teardown"
            or not checks["exact_teardown"]["evidence"].get("all_stopped_and_deleted")):
        raise ValidationError("Stage 2 report contains incomplete or non-passing observed probe evidence")
    cleanup_instances = qualification["cleanup"].get("instances")
    if (not isinstance(cleanup_instances, list) or len(cleanup_instances) != 2
            or any(not isinstance(name, str) for name in cleanup_instances)
            or len(set(cleanup_instances)) != 2):
        raise ValidationError("Stage 2 report does not identify both exactly torn-down guest instances")
    return qualification


def qualification_report_payload(*, base: str, hashes: dict, guest_tools: dict,
                                 probes: dict, checks: dict, cleanup_instances: list[str]) -> dict:
    required = {
        "guest_profile", "guest_boundary", "guest_egress", "other_guest_denied",
        "host_canary_denied", "host_lan_canary_denied", "host_ssh_continuity", "bounded_cancellation", "exact_teardown",
    }
    if (not SHA_RE.fullmatch(base) or not isinstance(hashes, dict) or not hashes
            or not isinstance(guest_tools, dict) or len(guest_tools) != 2
            or not isinstance(probes, dict) or not probes
            or not isinstance(checks, dict) or not required.issubset(checks)
            or any(not isinstance(checks[name], dict) or checks[name].get("status") != "passed"
                   or not isinstance(checks[name].get("evidence"), dict)
                   or not checks[name].get("evidence") for name in required)
            or not isinstance(cleanup_instances, list) or len(cleanup_instances) != 2
            or any(not isinstance(name, str) for name in cleanup_instances)
            or len(set(cleanup_instances)) != 2
            or checks["exact_teardown"]["evidence"].get("all_stopped_and_deleted") is not True):
        raise ValidationError("qualification checks or exact cleanup evidence are incomplete")
    validate_canary_evidence(checks)
    return {
        "schema": 2, "status": "qualified", "trusted_base": base,
        "trusted_runner_head": base, "trusted_tools_sha256": hashes,
        "lima_version": LIMA_VERSION, "guest_tools": guest_tools,
        "direct_probes": probes, "checks": checks,
        "cleanup": {"status": "complete", "instances": cleanup_instances},
        "candidate_transferred": False, "candidate_code_executed": False,
    }


def run_qualification(args):
    """Run only trusted, candidate-free probes and publish evidence after teardown."""
    cancel_requested.clear()
    root = verify_trusted_checkout(args.expected_base)
    report_path = Path(args.report).expanduser()
    destination = report_path.resolve(strict=False)
    if (destination == root or destination.is_relative_to(root) or not destination.parent.is_dir()
            or destination.exists() or destination.is_symlink()):
        raise ValidationError("qualification report must be a new file outside the trusted checkout")
    hashes = trusted_tool_hashes()
    lock_path = Path(tempfile.gettempdir()) / "jarvis-issue214-lima.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    os.fchmod(lock_fd, 0o600)
    runs = [LimaRun(secrets.token_hex(16)), LimaRun(secrets.token_hex(16))]
    checks = {}
    guest_tools = {}
    probes = {}
    cleanup_errors = []
    cancellation_requested = False
    old_sigterm = signal.signal(signal.SIGTERM, _interrupt)
    old_sigint = signal.signal(signal.SIGINT, _interrupt)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValidationError("another issue-214 Lima validation is active") from error
        with tempfile.TemporaryDirectory(prefix="jarvis-issue214-qualify-") as temp:
            controller = Path(temp) / "lima_guest_controller.py"
            profile = Path(temp) / "lima_execution.py"
            shutil.copyfile(GUEST_CONTROLLER, controller)
            shutil.copyfile(GUEST_PROFILE_HELPER, profile)
            for run in runs:
                run.create()
                run.verify()
                run.copy_to_guest(controller, "/var/tmp/lima_guest_controller.py")
                run.copy_to_guest(profile, "/var/tmp/lima_execution.py")
                run.shell("sudo", "chown", "root:root", "/var/tmp/lima_guest_controller.py",
                          "/var/tmp/lima_execution.py")
                run.shell("sudo", "chmod", "0600", "/var/tmp/lima_guest_controller.py",
                          "/var/tmp/lima_execution.py")
                ready = guest_action(run, "/var/tmp/lima_guest_controller.py", "qualification-prepare",
                                     timeout=60)
                if ready.get("status") != "qualification_guest_ready":
                    raise ValidationError("trusted guest did not provide qualification profile evidence")
                guest_tools[run.name] = ready.get("guest_tools")
                boundary = ready.get("boundary")
                if (not isinstance(boundary, dict) or boundary.get("probe_account_uid", 0) <= 0
                        or boundary.get("proxy_variable_names") or boundary.get("shared_mount_targets")
                        or boundary.get("agent_socket_environment_present")
                        or boundary.get("control_sockets_accessible_by_probe_user")):
                    raise ValidationError("qualification guest boundary evidence was incomplete or unsafe")
                checks["guest_profile"] = {"status": "passed", "evidence": ready.get("guest_tools")}
                checks["guest_boundary"] = {"status": "passed", "evidence": boundary}
            second_ip_text = runs[1].shell("ip", "-4", "-o", "addr", "show", "dev", "eth0", timeout=20)
            second_ip_match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)/", second_ip_text)
            if not second_ip_match:
                raise ValidationError("second qualification guest has no IPv4 address")
            route = runs[0].shell("ip", "-4", "route", "show", "default", timeout=20)
            gateway_match = re.search(r"^default via (\d+\.\d+\.\d+\.\d+)", route)
            if not gateway_match:
                raise ValidationError("qualification guest has no IPv4 gateway")
            forward_port = int(get_instance(runs[0].name).get("sshLocalPort", 0))
            if not 1 <= forward_port <= 65535:
                raise ValidationError("Lima controller SSH forwarding port is invalid")
            interface, lan_ip = active_lan_ipv4()
            with HostCanary(HOST_SSH_SOURCE) as canary, HostCanary(lan_ip) as lan_canary:
                probe = guest_action(runs[0], "/var/tmp/lima_guest_controller.py", "probe", [
                    "--host-ip", HOST_SSH_SOURCE, "--host-canary-port", str(canary.port),
                    "--lan-ip", lan_ip, "--lan-canary-port", str(lan_canary.port),
                    "--host-forward-port", str(forward_port), "--gateway-ip", gateway_match.group(1),
                    "--other-guest-ip", second_ip_match.group(1),
                ], timeout=60)
                evidence = probe.get("evidence")
                if probe.get("status") != "isolation_verified" or not isinstance(evidence, dict):
                    raise ValidationError("guest isolation probe did not return validated direct evidence")
                probes = evidence
                with canary.accepted_lock:
                    accepted_connections = canary.accepted
                with lan_canary.accepted_lock:
                    lan_accepted_connections = lan_canary.accepted
                if accepted_connections != 0:
                    raise ValidationError("host canary received an unauthorized guest connection")
                if lan_accepted_connections != 0:
                    raise ValidationError("Mac LAN canary received an unauthorized guest connection")
                checks["guest_egress"] = {"status": "passed", "evidence": evidence}
                checks["other_guest_denied"] = {"status": "passed", "evidence": {
                    "probe": evidence.get("ipv4_details", {}).get("other_instance"),
                    "second_guest_running": True}}
                checks["host_canary_denied"] = {"status": "passed", "evidence": {
                    "probe": evidence.get("ipv4_details", {}).get("host_loopback"),
                    "canary_connections_accepted": accepted_connections}}
                lan_probe = evidence.get("ipv4_details", {}).get("host_lan")
                if isinstance(lan_probe, dict):
                    lan_probe = {**lan_probe, "interface": interface}
                checks["host_lan_canary_denied"] = {"status": "passed", "evidence": {
                    "interface": interface, "probe": lan_probe,
                    "canary_connections_accepted": lan_accepted_connections}}
                alias = f"lima-{runs[0].name}"
                ssh_config = str(Path(get_instance(runs[0].name)["sshConfigFile"]))
                ssh_result = run_host(["ssh", "-F", ssh_config, "-o", "ControlMaster=no",
                                       "-o", "ControlPath=none", alias, "true"], timeout=30,
                                      output_limit=4096)
                checks["host_ssh_continuity"] = {"status": "passed", "evidence": {
                    "fresh_ssh_exit": 0, "output": ssh_result}}
            # Cancel an active trusted command inside the guest. The guest may
            # retain that process after the SSH control process dies; exact VM
            # teardown below must therefore stop/delete its containing VM.
            started = time.monotonic()
            cancel_requested.clear()
            marker = "/var/tmp/jv214-qualification-cancel.pid"
            remote_code = ("import os,time,pathlib; "
                           f"pathlib.Path({marker!r}).write_text(str(os.getpid())); "
                           "time.sleep(30)")
            cancellation_result = []
            def run_cancel_command():
                try:
                    run_host(["limactl", "shell", "--workdir", "/var/tmp", runs[0].name,
                              "--", "sudo", "/usr/bin/python3", "-c", remote_code],
                             timeout=40, output_limit=4096)
                    cancellation_result.append("completed")
                except BaseException as error:
                    cancellation_result.append(error)
            command_thread = threading.Thread(target=run_cancel_command, daemon=True)
            command_thread.start()
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    try:
                        runs[0].shell("sudo", "test", "-s", marker, timeout=10, output_limit=1024)
                        break
                    except ValidationError:
                        time.sleep(0.1)
                else:
                    raise ValidationError("guest cancellation probe did not reach its running state")
                cancel_requested.set()
                command_thread.join(timeout=10)
                if command_thread.is_alive():
                    raise ValidationError("cancelled Lima shell did not terminate")
                if (len(cancellation_result) != 1
                        or not isinstance(cancellation_result[0], InterruptedValidation)
                        or "process group reaped" not in str(cancellation_result[0])):
                    raise ValidationError("active guest cancellation did not reap its host control process")
                cancel_requested.clear()
                pid_text = runs[0].shell("sudo", "cat", marker, timeout=10, output_limit=1024)
                if not pid_text.isdigit():
                    raise ValidationError("guest cancellation probe returned an invalid process identity")
                process_state = runs[0].shell("sudo", "sh", "-c",
                    f"ps -o stat= -p {int(pid_text)} || true", timeout=10, output_limit=1024).strip()
                runs[0].shell("sudo", "rm", "-f", marker, timeout=10, output_limit=1024)
            finally:
                if command_thread.is_alive():
                    cancel_requested.set()
                    command_thread.join(timeout=10)
                cancel_requested.clear()
            if command_thread.is_alive():
                raise ValidationError("cancellation probe worker did not stop")
            checks["bounded_cancellation"] = {"status": "passed", "evidence": {
                "mechanism": "active Lima shell cancellation followed by exact VM teardown",
                "host_process_group_reaped": True, "guest_process_state_before_teardown": process_state,
                "guest_process_containment": "exact_vm_teardown",
                "elapsed_seconds": time.monotonic() - started}}
    finally:
        cancellation_requested = cancel_requested.is_set()
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cancel_requested.clear()
        for run in reversed(runs):
            try:
                run.cleanup()
            except Exception as error:
                cleanup_errors.append({"instance": run.name, "error_type": type(error).__name__})
        try:
            os.close(lock_fd)
        finally:
            signal.signal(signal.SIGTERM, old_sigterm)
            signal.signal(signal.SIGINT, old_sigint)
    if cleanup_errors:
        raise ValidationError("exact qualification VM teardown failed; no report was written")
    if cancellation_requested:
        raise InterruptedValidation("qualification cancelled; exact guest teardown completed and no report was written")
    checks["exact_teardown"] = {"status": "passed", "evidence": {
        "instances": [run.name for run in runs], "all_stopped_and_deleted": True}}
    qualification = qualification_report_payload(
        base=args.expected_base, hashes=hashes, guest_tools=guest_tools,
        probes=probes, checks=checks, cleanup_instances=[run.name for run in runs],
    )
    write_report(destination, qualification, root)


def run_validation(args):
    if getattr(args, "qualify_only", False):
        if args.enable_candidate_execution or args.qualification_report or args.workspace:
            raise ValidationError("qualification-only mode cannot accept candidate execution inputs")
        return run_qualification(args)
    cancel_requested.clear()
    report_root = trusted_root().resolve(strict=False)
    report_path = Path(args.report)
    report = {"schema": 1, "status": "failed", "base": args.expected_base,
              "head": args.expected_head, "cleanup": "not_started", "candidate_result": None}
    old_sigterm = signal.signal(signal.SIGTERM, _interrupt)
    old_sigint = signal.signal(signal.SIGINT, _interrupt)
    try:
        _run_validation_impl(args, report, report_path, report_root)
    except Exception as error:
        if not report_path.exists() and not report_path.is_symlink():
            failure = {**report, "status": "failed", "cleanup": report.get("cleanup", "not_started"),
                       "error_type": type(error).__name__}
            try:
                write_report(report_path, failure, report_root)
            except Exception:
                pass
        raise
    finally:
        signal.signal(signal.SIGTERM, old_sigterm)
        signal.signal(signal.SIGINT, old_sigint)


def _run_validation_impl(args, report, report_path, report_root):
    if not args.enable_candidate_execution:
        raise ValidationError("candidate execution requires explicit Stage 2 operator opt-in")
    if not args.qualification_report:
        raise ValidationError("Stage 2 qualification evidence report is required")
    root = verify_trusted_checkout(args.expected_base)
    if not SHA_RE.fullmatch(args.expected_head):
        raise ValidationError("expected head must be a full lowercase commit ID")
    workspace = Path(args.workspace).resolve(strict=True)
    if workspace == root or workspace.is_relative_to(root) or root.is_relative_to(workspace):
        raise ValidationError("candidate snapshot must be separate from the trusted checkout")
    qualification = load_qualification_report(Path(args.qualification_report), workspace=workspace,
                                              trusted_root=root, expected_base=args.expected_base)
    verify_workspace(workspace, args.expected_base, args.expected_head)
    verify_candidate_package_setup(root, workspace)
    node_version, pnpm_version, postgres_image, pnpm_integrity = trusted_pins(root)

    lock_path = Path(tempfile.gettempdir()) / "jarvis-issue214-lima.lock"
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    os.fchmod(lock_fd, 0o600)
    run = None
    second = None
    guest_ready = False
    report["postgres_image"] = postgres_image
    old_sigterm = signal.signal(signal.SIGTERM, _interrupt)
    old_sigint = signal.signal(signal.SIGINT, _interrupt)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValidationError("another issue-214 Lima validation is active") from error
        run_id = secrets.token_hex(16)
        run = LimaRun(run_id)
        second = LimaRun(secrets.token_hex(16))
        report.update({
            "run_id": run_id, "lima_version": LIMA_VERSION,
            "guest": {"arch": "aarch64", "cpus": 4, "memory_gib": MEMORY_GIB,
                      "disk_gib": DISK_GIB, "os": "Ubuntu 24.04", "proxy_propagation": False},
            "test_command": candidate_test_command(), "candidate_result": None,
            "cleanup": "pending", "limitations": [],
        })
        canary = None
        with tempfile.TemporaryDirectory(prefix="jarvis-issue214-lima-") as temp:
            temp_root = Path(temp)
            seed_archive = temp_root / "trusted-seed.tar"
            trusted_seed(root, args.expected_base, seed_archive)
            run.create()
            run.verify()
            guest_controller = temp_root / "lima_guest_controller.py"
            guest_profile = temp_root / "lima_execution.py"
            shutil.copyfile(GUEST_CONTROLLER, guest_controller)
            shutil.copyfile(GUEST_PROFILE_HELPER, guest_profile)
            run.copy_to_guest(guest_controller, "/var/tmp/lima_guest_controller.py")
            run.copy_to_guest(guest_profile, "/var/tmp/lima_execution.py")
            guest_workspace_helper = temp_root / "prepare_validation_workspace.py"
            shutil.copyfile(GUEST_WORKSPACE_HELPER, guest_workspace_helper)
            run.copy_to_guest(guest_workspace_helper, "/var/tmp/jv214_prepare_validation.py")
            run.copy_to_guest(seed_archive, "/var/tmp/jv214-trusted-seed.tar")
            run.shell("sudo", "chown", "root:root", "/var/tmp/lima_guest_controller.py",
                      "/var/tmp/lima_execution.py", "/var/tmp/jv214_prepare_validation.py",
                      "/var/tmp/jv214-trusted-seed.tar")
            run.shell("sudo", "chmod", "0600", "/var/tmp/lima_guest_controller.py",
                      "/var/tmp/lima_execution.py", "/var/tmp/jv214_prepare_validation.py",
                      "/var/tmp/jv214-trusted-seed.tar")
            run.shell("sudo", "mkdir", "-p", "/var/tmp/jv214-trusted-seed")
            run.shell("sudo", "tar", "-xf", "/var/tmp/jv214-trusted-seed.tar", "-C", "/var/tmp/jv214-trusted-seed")
            guest_action(run, "/var/tmp/lima_guest_controller.py", "bootstrap", [
                "--node-version", node_version, "--pnpm-version", pnpm_version,
                "--pnpm-integrity", pnpm_integrity,
                "--postgres-image", postgres_image, "--trusted-workspace", "/var/tmp/jv214-trusted-seed",
            ], timeout=MAX_SETUP_SECONDS + 600)
            guest_ready = True

            second.create()
            second.verify()
            guest_action(second, "/var/tmp/lima_guest_controller.py", "firewall", timeout=30)
            second_ip = second.shell("ip", "-4", "-o", "addr", "show", "dev", "eth0", timeout=20)
            second_match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)/", second_ip)
            if not second_match:
                raise ValidationError("second trusted-only guest has no IPv4 address")
            other_guest_ip = second_match.group(1)
            run.verify()
            guest_action(run, "/var/tmp/lima_guest_controller.py", "firewall", timeout=30)
            route = run.shell("ip", "-4", "route", "show", "default", timeout=20)
            gateway_match = re.search(r"^default via (\d+\.\d+\.\d+\.\d+)", route)
            if not gateway_match:
                raise ValidationError("main guest has no IPv4 gateway route")
            forward_port = int(get_instance(run.name).get("sshLocalPort", 0))
            if not 1 <= forward_port <= 65535:
                raise ValidationError("Lima controller SSH forwarding port is invalid")
            interface, lan_ip = active_lan_ipv4()
            with HostCanary(HOST_SSH_SOURCE) as canary, HostCanary(lan_ip) as lan_canary:
                probe = guest_action(run, "/var/tmp/lima_guest_controller.py", "probe", [
                    "--host-ip", HOST_SSH_SOURCE, "--host-canary-port", str(canary.port),
                    "--lan-ip", lan_ip, "--lan-canary-port", str(lan_canary.port),
                    "--host-forward-port", str(forward_port), "--gateway-ip", gateway_match.group(1),
                    "--other-guest-ip", other_guest_ip,
                ], timeout=90)
                report["isolation_probe"] = probe
                run.verify()
                # Prove a fresh host-initiated SSH session survives the guest filter.
                alias = f"lima-{run.name}"
                ssh_config = str(Path(get_instance(run.name)["sshConfigFile"]))
                run_host(["ssh", "-F", ssh_config, "-o", "ControlMaster=no", "-o", "ControlPath=none",
                          alias, "true"], timeout=30, output_limit=4096)
                # Candidate source is transferred only after every probe above passes.
                run.copy_to_guest(workspace, "/var/tmp/", recursive=True, timeout=300)
                guest_workspace = "/var/tmp/" + workspace.name
                stage = guest_action(run, "/var/tmp/lima_guest_controller.py", "stage", [
                    "--source", guest_workspace, "--expected-base", args.expected_base,
                    "--expected-head", args.expected_head,
                ], timeout=120)
                report["candidate_stage"] = stage
                guest_action(run, "/var/tmp/lima_guest_controller.py", "database", [
                    "--postgres-image", postgres_image,
                ], timeout=180)
                test_result = guest_action(run, "/var/tmp/lima_guest_controller.py", "test", [
                    "--expected-base", args.expected_base, "--expected-head", args.expected_head,
                ], timeout=MAX_TEST_SECONDS + 120)
                report["candidate_result"] = test_result
                if test_result.get("status") != "candidate_result" or test_result.get("passed") is not True:
                    raise ValidationError("guest persistence acceptance failed")
                final_snapshot = guest_action(run, "/var/tmp/lima_guest_controller.py", "finish", [
                    "--expected-base", args.expected_base, "--expected-head", args.expected_head,
                ], timeout=120)
                report["snapshot_after_test"] = final_snapshot
                guest_cleanup = guest_action(run, "/var/tmp/lima_guest_controller.py", "cleanup", [
                    "--postgres-image", postgres_image,
                ], timeout=90)
                report["guest_cleanup"] = guest_cleanup
                # Candidate files remain only until the exact VM teardown.
                report["status"] = "passed"
        if cancel_requested.is_set():
            raise InterruptedValidation("validation cancelled after candidate checks")
        report["status"] = "passed"
    finally:
        # Once teardown starts, repeated terminal cancellation must not bypass
        # the exact-identity cleanup/report path.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # A cancellation request is handled; clear it so teardown commands can
        # run to completion under the existing exact-identity checks.
        cancel_requested.clear()
        cleanup_errors = []
        if run is not None and run.created and guest_ready and postgres_image:
            try:
                report["guest_cleanup"] = guest_action(
                    run, "/var/tmp/lima_guest_controller.py", "cleanup",
                    ["--postgres-image", postgres_image], timeout=90,
                )
            except Exception as error:
                cleanup_errors.append("guest_" + type(error).__name__)
        for instance in (second, run):
            if instance is None:
                continue
            try:
                instance.cleanup()
            except Exception as error:
                cleanup_errors.append(type(error).__name__)
        attempted = any(instance is not None and instance.ever_created
                        for instance in (second, run))
        report["cleanup"] = "incomplete" if cleanup_errors else (
            "complete" if attempted else "not_required")
        if cleanup_errors:
            report["status"] = "cleanup_incomplete"
            report["cleanup_errors"] = cleanup_errors
        try:
            write_report(report_path, report, report_root)
        except Exception as error:
            report["report_write"] = "failed:" + type(error).__name__
        finally:
            os.close(lock_fd)
            signal.signal(signal.SIGTERM, old_sigterm)
            signal.signal(signal.SIGINT, old_sigint)
        if cleanup_errors:
            raise ValidationError("exact Lima instance cleanup is uncertain; retained resources for handoff")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualify-only", action="store_true",
                        help="run candidate-free trusted-base probes and generate Stage 2 evidence")
    parser.add_argument("--workspace", help="exact prepared B/H validation snapshot")
    parser.add_argument("--expected-base", required=True, help="full trusted base commit SHA")
    parser.add_argument("--expected-head", help="full candidate head commit SHA")
    parser.add_argument("--enable-candidate-execution", action="store_true",
                        help="explicit Stage 2 operator action; requires a complete qualification report")
    parser.add_argument("--qualification-report", help="trusted Stage 2 report proving all Lima gates")
    parser.add_argument("--report", default="/private/var/tmp/jv214-lima-report.json",
                        help="new sanitized report path outside the source checkout")
    args = parser.parse_args(argv)
    try:
        if args.qualify_only and (args.workspace or args.expected_head or args.enable_candidate_execution
                                  or args.qualification_report):
            raise ValidationError("qualification-only mode is candidate-free and accepts no candidate inputs")
        if not args.qualify_only and (not args.workspace or not args.expected_head):
            raise ValidationError("candidate execution mode requires workspace and expected head")
        run_validation(args)
        return 0
    except (ValidationError, LimaValidationError, OSError, ValueError, KeyError, IndexError) as error:
        report_path = Path(args.report)
        if not args.qualify_only and not report_path.exists() and not report_path.is_symlink():
            fallback = {
                "schema": 1, "status": "failed", "base": args.expected_base,
                "head": args.expected_head, "cleanup": "not_started",
                "error_type": type(error).__name__, "candidate_result": None,
            }
            try:
                write_report(report_path, fallback, trusted_root())
            except Exception:
                pass
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}, sort_keys=True),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
