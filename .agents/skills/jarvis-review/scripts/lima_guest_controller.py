#!/usr/bin/env python3
"""Trusted guest-side controller for issue-214 (invoked only inside Lima)."""

from __future__ import annotations

import argparse
import base64
import errno
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time


USER = "jarvis-review"
STORE = Path("/var/lib/jarvis-review/pnpm-store")
HOME = Path("/home/jarvis-review")
WORK = HOME / "candidate"
ROOT = Path("/var/lib/jarvis-review")
DB_ENV = Path("/run/jv214/postgres.env")
DB_URL = Path("/run/jv214/database-url")
CANDIDATE_ENV = Path("/run/jv214/candidate.env")
TEST_LOG = Path("/run/jv214/persistence-test.log")
CANDIDATE_UNIT = Path("/var/lib/jarvis-review/candidate-unit")
DB_ATTEMPT = Path("/var/lib/jarvis-review/database-attempt")
DB_NAME_PREFIX = "jv214-pg-"
MAX_OUTPUT = 32 * 1024 * 1024
MAX_TEST_SECONDS = 20 * 60
MAX_SETUP_SECONDS = 10 * 60
WORKSPACE_HELPER = Path("/var/tmp/jv214_prepare_validation.py")
# SHA-256 pinned in reviewed trusted source; do not trust a checksum fetched
# beside the artifact from the same mutable origin.
NODE_ARM64_SHA256 = {
    "24.22.0": "fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143",
}


class GuestError(Exception):
    pass


def emit(**payload):
    print(json.dumps(payload, sort_keys=True), flush=True)


def run(args, *, timeout=60, cwd=None, input_text=None, env=None, output_limit=2 * 1024 * 1024):
    text, returncode = run_bounded(
        args, timeout=timeout, cwd=cwd, input_text=input_text, env=env,
        output_limit=output_limit,
    )
    if returncode:
        # Do not relay arbitrary setup output, which may contain credentials.
        raise GuestError(f"guest command failed: {args[0]} (exit {returncode})")
    return text.strip()


def run_bounded(args, *, timeout=60, cwd=None, input_text=None, env=None,
                output_limit=2 * 1024 * 1024, output_file=None, on_terminate=None):
    """Stream bounded output; optionally persist at most output_limit bytes."""
    safe_env = env or {
        "HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LC_ALL": "C", "DEBIAN_FRONTEND": "noninteractive",
    }
    process = None
    captured = bytearray()
    written = 0
    overflow = threading.Event()
    write_error = []
    termination_errors = []
    try:
        process = subprocess.Popen(
            args, cwd=cwd, env=safe_env,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        )

        def terminate():
            if on_terminate is not None:
                try:
                    on_terminate()
                except BaseException as error:
                    termination_errors.append(error)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        def drain():
            nonlocal written
            while True:
                chunk = process.stdout.read(65536)
                if not chunk:
                    return
                if written + len(chunk) > output_limit:
                    remaining = max(0, output_limit - written)
                    if output_file is not None and remaining:
                        output_file.write(chunk[:remaining])
                        output_file.flush()
                    written += remaining
                    if not overflow.is_set():
                        overflow.set()
                        terminate()
                    continue
                if output_file is None:
                    captured.extend(chunk)
                else:
                    output_file.write(chunk)
                    output_file.flush()
                written += len(chunk)

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
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            terminate()
            process.wait()
            reader.join(timeout=2)
            if writer is not None:
                writer.join(timeout=2)
            raise GuestError(f"guest command timed out: {args[0]}") from error
        if writer is not None:
            writer.join(timeout=2)
        reader.join(timeout=2)
        if reader.is_alive():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise GuestError("guest command left an output-producing process")
        if overflow.is_set():
            raise GuestError("guest command output exceeded the configured limit")
        if termination_errors:
            raise GuestError("candidate process service termination is uncertain") from termination_errors[0]
        if write_error and process.returncode == 0:
            raise GuestError("guest command input could not be delivered")
        text = captured.decode("utf-8", errors="replace")
    except GuestError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        raise GuestError(f"guest command did not complete: {args[0]}") from error
    finally:
        if process is not None:
            if process.stdout is not None:
                process.stdout.close()
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
    return text, process.returncode


def account():
    try:
        return pwd.getpwnam(USER)
    except KeyError:
        return None


def install_toolchain(args):
    """Provision tools and trusted-base cache before any candidate is copied."""
    if os.geteuid() != 0:
        raise GuestError("toolchain provisioning requires guest root")
    if account() is not None:
        raise GuestError("fresh guest unexpectedly contains the candidate account")
    if not re.fullmatch(r"24\.[0-9]+\.[0-9]+", args.node_version):
        raise GuestError("trusted Node pin is invalid")
    expected_node_sha = NODE_ARM64_SHA256.get(args.node_version)
    if expected_node_sha is None:
        raise GuestError("trusted Node version has no reviewed ARM64 artifact digest")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.pnpm_version):
        raise GuestError("trusted pnpm pin is invalid")
    if not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==?", args.pnpm_integrity):
        raise GuestError("trusted pnpm integrity pin is invalid")
    if not re.fullmatch(r"postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", args.postgres_image):
        raise GuestError("trusted PostgreSQL image pin is invalid")

    run(["apt-get", "update"], timeout=180, output_limit=8 * 1024 * 1024)
    run(["apt-get", "install", "-y", "--no-install-recommends", "curl", "xz-utils", "podman", "nftables"],
        timeout=300, output_limit=8 * 1024 * 1024)
    node_root = Path("/opt/jv214-node")
    archive_root = Path("/var/tmp/jv214-toolchain")
    archive_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    tarball = f"node-v{args.node_version}-linux-arm64.tar.xz"
    base_url = f"https://nodejs.org/dist/v{args.node_version}"
    run(["curl", "-fsS", "-o", str(archive_root / tarball), f"{base_url}/{tarball}"], timeout=180)
    actual_node_sha = run(["sha256sum", str(archive_root / tarball)], cwd=archive_root).split()[0]
    if actual_node_sha != expected_node_sha:
        raise GuestError("Node.js archive checksum did not verify")
    run(["tar", "-xJf", str(archive_root / tarball), "-C", str(archive_root)], timeout=120)
    extracted = archive_root / f"node-v{args.node_version}-linux-arm64"
    if node_root.exists() or node_root.is_symlink():
        raise GuestError("Node installation path already exists")
    node_root.symlink_to(extracted)
    node_bin = node_root / "bin"
    if run([str(node_bin / "node"), "--version"], timeout=15) != f"v{args.node_version}":
        raise GuestError("installed Node.js version does not match the trusted pin")

    account_info = run(["useradd", "--create-home", "--shell", "/bin/bash", USER])
    del account_info
    user = pwd.getpwnam(USER)
    if user.pw_gid == 0 or user.pw_uid == 0:
        raise GuestError("candidate account is privileged")
    groups = run(["id", "-nG", USER]).split()
    if any(group in {"sudo", "docker", "podman", "lxd", "disk", "root"} for group in groups):
        raise GuestError("candidate account has a privileged or container-control group")

    trusted_workspace = Path(args.trusted_workspace).resolve(strict=True)
    if not trusted_workspace.is_dir():
        raise GuestError("trusted dependency workspace is missing")
    pnpm_root = Path("/opt/jv214-pnpm")
    pnpm_archive = archive_root / "pnpm.tgz"
    run(["curl", "-fsS", "-o", str(pnpm_archive),
         f"https://registry.npmjs.org/pnpm/-/pnpm-{args.pnpm_version}.tgz"], timeout=180)
    digest = subprocess.run(
        ["openssl", "dgst", "-sha512", "-binary", str(pnpm_archive)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
    )
    if digest.returncode:
        raise GuestError("pnpm archive digest could not be computed")
    actual_integrity = "sha512-" + base64.b64encode(digest.stdout).decode("ascii")
    if actual_integrity != args.pnpm_integrity:
        raise GuestError("pnpm archive does not match trusted lockfile integrity")
    if pnpm_root.exists() or pnpm_root.is_symlink():
        raise GuestError("pnpm installation path already exists")
    pnpm_root.mkdir(mode=0o755)
    run(["tar", "-xzf", str(pnpm_archive), "--strip-components=1", "-C", str(pnpm_root)], timeout=90)
    pnpm_cli = pnpm_root / "bin/pnpm.cjs"
    if not pnpm_cli.is_file() or pnpm_cli.is_symlink():
        raise GuestError("pinned pnpm archive has no regular CLI entrypoint")

    for location in (ROOT, STORE):
        location.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(trusted_workspace, user.pw_uid, user.pw_gid)
    for path in trusted_workspace.rglob("*"):
        if path.is_symlink():
            raise GuestError("trusted dependency seed contains a symlink")
        os.chown(path, user.pw_uid, user.pw_gid)
    os.chown(STORE, user.pw_uid, user.pw_gid)
    os.chown(ROOT, 0, 0)
    os.chmod(ROOT, 0o711)
    pnpm_env = {"HOME": str(HOME), "PATH": f"{node_bin}:/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C"}
    if run([str(node_bin / "node"), str(pnpm_cli), "--version"],
           timeout=20, env=pnpm_env) != args.pnpm_version:
        raise GuestError("installed pnpm version does not match trusted packageManager pin")
    wrapper = Path("/usr/local/bin/pnpm")
    if wrapper.exists() or wrapper.is_symlink():
        raise GuestError("pnpm wrapper path already exists")
    wrapper.write_text(
        "#!/bin/sh\nexec /opt/jv214-node/bin/node /opt/jv214-pnpm/bin/pnpm.cjs \"$@\"\n", encoding="utf-8",
    )
    wrapper.chmod(0o755)
    package_env = {
        **pnpm_env,
        "PNPM_STORE_DIR": str(STORE), "npm_config_store_dir": str(STORE),
        "npm_config_ignore_scripts": "true", "NPM_CONFIG_USERCONFIG": "/dev/null",
        "NPM_CONFIG_GLOBALCONFIG": "/dev/null",
    }
    run([
        str(node_bin / "node"), str(pnpm_cli), "--store-dir", str(STORE),
        "install", "--frozen-lockfile", "--ignore-scripts",
    ], cwd=trusted_workspace, timeout=MAX_SETUP_SECONDS, env=package_env, output_limit=8 * 1024 * 1024)
    # Remove only the disposable trusted-seed installation; retain the content store.
    for path in [trusted_workspace / "node_modules", *trusted_workspace.glob("apps/*/node_modules"),
                 *trusted_workspace.glob("packages/*/node_modules")]:
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise GuestError("trusted seed generated output changed type")
        if path.exists():
            shutil.rmtree(path)
    run(["podman", "pull", "--policy", "always", "--arch", "arm64", args.postgres_image],
        timeout=MAX_SETUP_SECONDS, output_limit=8 * 1024 * 1024)
    emit(status="toolchain_ready", node=f"v{args.node_version}", pnpm=args.pnpm_version,
         postgres_image=args.postgres_image)


def firewall_install():
    if os.geteuid() != 0:
        raise GuestError("firewall installation requires guest root")
    run(["nft", "-f", "-"], input_text=firewall_rules(), timeout=20)
    output = run(["nft", "list", "ruleset"], timeout=20)
    validate_firewall_rules(output)
    emit(status="firewall_installed")


def qualification_prepare():
    """Prepare a candidate-free guest with only an unprivileged probe account."""
    if os.geteuid() != 0:
        raise GuestError("qualification preparation requires guest root")
    if account() is not None:
        raise GuestError("fresh qualification guest unexpectedly has the probe account")
    if shutil.which("nft") is None:
        run(["apt-get", "update"], timeout=180, output_limit=4 * 1024 * 1024)
        run(["apt-get", "install", "-y", "--no-install-recommends", "nftables"],
            timeout=180, output_limit=4 * 1024 * 1024)
    if shutil.which("nft") is None:
        raise GuestError("candidate-free guest could not provision its trusted nftables probe tool")
    run(["useradd", "--create-home", "--shell", "/bin/bash", USER], timeout=20)
    user = pwd.getpwnam(USER)
    groups = run(["id", "-nG", USER]).split()
    if (user.pw_uid == 0 or user.pw_gid == 0
            or any(group in {"sudo", "docker", "podman", "lxd", "disk", "root"} for group in groups)):
        raise GuestError("qualification probe account is privileged")
    firewall_install()

    init_env = Path("/proc/1/environ").read_bytes().split(b"\0")
    init_names = sorted({
        item.split(b"=", 1)[0].decode("ascii", errors="ignore")
        for item in init_env if b"=" in item
        and item.split(b"=", 1)[0].lower().endswith((b"_proxy", b"_proxy"))
    })
    process_proxy_names = sorted(key for key in os.environ if key.lower().endswith("_proxy"))
    proxy_names = sorted(set(init_names + process_proxy_names))
    mountinfo = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
    shared_mounts = []
    for line in mountinfo.splitlines():
        fields = line.split()
        if "-" not in fields:
            continue
        separator = fields.index("-")
        if separator + 1 < len(fields) and fields[separator + 1] in {
            "9p", "virtiofs", "fuse.sshfs", "virtiofsd",
        }:
            shared_mounts.append(fields[4])
    socket_paths = (
        Path("/run/podman/podman.sock"), Path("/var/run/docker.sock"),
        Path("/run/host-services/ssh-auth.sock"), Path("/run/host-services/host-ssh.sock"),
    )
    accessible_sockets = []
    for path in socket_paths:
        if not path.exists():
            continue
        result = subprocess.run(
            ["/usr/sbin/runuser", "-u", USER, "--", "/usr/bin/test", "-r", str(path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
        if result.returncode == 0:
            accessible_sockets.append(str(path))
    agent_env = "SSH_AUTH_SOCK" in os.environ or "SSH_AUTH_SOCK" in {
        item.split(b"=", 1)[0].decode("ascii", errors="ignore")
        for item in init_env if b"=" in item
    }
    if proxy_names or shared_mounts or accessible_sockets or agent_env:
        raise GuestError("qualification guest exposes proxy, host mount, agent, or control socket state")

    uname = run(["uname", "-a"], timeout=10)
    python_version = run([sys.executable, "--version"], timeout=10)
    nft_version = run(["nft", "--version"], timeout=10)
    os_release = {}
    for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
        if line.startswith(("ID=", "VERSION_ID=")):
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    emit(
        status="qualification_guest_ready",
        guest_tools={"uname": uname, "python": python_version, "nftables": nft_version,
                     "os_release": os_release},
        boundary={"probe_account_uid": user.pw_uid, "probe_groups": groups,
                  "proxy_variable_names": proxy_names, "shared_mount_targets": shared_mounts,
                  "agent_socket_environment_present": agent_env,
                  "control_sockets_accessible_by_probe_user": accessible_sockets,
                  "firewall_rules": run(["nft", "list", "ruleset"], timeout=20)},
    )


def firewall_rules():
    from lima_execution import firewall_rules as rules
    return rules()


def validate_firewall_rules(output):
    from lima_execution import validate_firewall_rules as validate
    validate(output)


def probe_network(args):
    """Run direct unprivileged probes to host/LAN/Internet and report exact states."""
    if os.geteuid() != 0 or account() is None:
        raise GuestError("isolation probe requires a provisioned guest and root controller")
    firewall = run(["nft", "list", "ruleset"], timeout=20)
    validate_firewall_rules(firewall)
    user = pwd.getpwnam(USER)
    targets = {
        "host_loopback": (args.host_ip, args.host_canary_port),
        "host_lan": (args.lan_ip, args.lan_canary_port),
        "host_ssh": (args.host_ip, 22),
        "hostagent_forward": (args.host_ip, args.host_forward_port),
        "lan_gateway": (args.gateway_ip, 22),
        "public_ipv4": ("1.1.1.1", 443),
        "ipv4_dns": ("8.8.8.8", 53),
    }
    results = {}
    probe_details = {}
    for label, address in targets.items():
        probe_details[label] = direct_probe(address[0], address[1], ipv6=False)
        results[label] = probe_details[label]["outcome"]
    other_ip = args.other_guest_ip
    probe_details["other_instance"] = direct_probe(other_ip, 22, ipv6=False)
    results["other_instance"] = probe_details["other_instance"]["outcome"]
    v6_routes = Path("/proc/net/ipv6_route").read_text(encoding="ascii")
    has_v6_default = any(line.split()[0:2] == ["0" * 32, "00"] for line in v6_routes.splitlines() if line.split())
    if has_v6_default:
        ipv6_detail = direct_probe("2606:4700:4700::1111", 443, ipv6=True)
        ipv6 = ipv6_detail["outcome"]
        ipv6_detail.update({"default_route_present": True, "route_table": v6_routes})
    else:
        ipv6 = "no_route"
        ipv6_detail = {"target_ip": "2606:4700:4700::1111", "target_port": 443,
                       "connect_errno": None, "outcome": "no_route",
                       "default_route_present": False, "route_table": v6_routes}

    # Verify the candidate identity cannot mutate firewall state.
    cmd = ["/usr/sbin/runuser", "-u", USER, "--", "nft", "flush", "ruleset"]
    denied = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    firewall_change = "denied" if denied.returncode != 0 else "allowed"
    firewall_output = denied.stderr.strip()[:512]
    evidence = {
        "ipv4": results, "ipv6": ipv6,
        "ipv4_details": probe_details, "ipv6_detail": ipv6_detail,
        "firewall_change_as_candidate_user": firewall_change,
        "firewall_change_returncode": denied.returncode,
        "firewall_change_stderr": firewall_output,
        "firewall_rules": firewall,
    }
    emit(status="isolation_probe_results", evidence=evidence)
    from lima_execution import validate_isolation_probes
    validate_isolation_probes(evidence)
    emit(status="isolation_verified", evidence=evidence)


def classify_probe_errno(code):
    if code == 0 or code == errno.ECONNREFUSED:
        return "reachable"
    blocked = {
        errno.EACCES, errno.EPERM, errno.EAGAIN, errno.EWOULDBLOCK,
        errno.ETIMEDOUT, errno.ENETUNREACH, errno.EHOSTUNREACH,
        errno.EHOSTDOWN, errno.ENETDOWN,
    }
    return "blocked" if code in blocked else "indeterminate"


def direct_probe(ip, port, *, ipv6):
    """Collect a connect errno from a fresh unprivileged guest process."""
    probe_source = (
        "import errno,json,socket,sys; "
        "family=socket.AF_INET6 if sys.argv[3]=='6' else socket.AF_INET; "
        "s=socket.socket(family,socket.SOCK_STREAM); s.settimeout(1.5); "
        "code=s.connect_ex((sys.argv[1],int(sys.argv[2]))); s.close(); "
        "print(json.dumps({'connect_errno':code}))"
    )
    try:
        result = subprocess.run(
            ["/usr/sbin/runuser", "-u", USER, "--", sys.executable, "-c", probe_source,
             ip, str(port), "6" if ipv6 else "4"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5, check=False,
            env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                 "HOME": str(HOME), "LC_ALL": "C"},
        )
        if result.returncode != 0:
            raise GuestError("unprivileged direct network probe could not run")
        detail = json.loads(result.stdout)
        code = detail.get("connect_errno")
        if not isinstance(code, int):
            raise GuestError("unprivileged direct network probe returned no errno")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise GuestError("unprivileged direct network probe failed") from error
    outcome = classify_probe_errno(code)
    return {"target_ip": ip, "target_port": port, "connect_errno": code, "outcome": outcome}


def install_candidate(args):
    if os.geteuid() != 0:
        raise GuestError("candidate staging requires guest root")
    if account() is None:
        raise GuestError("candidate account is missing")
    output = run(["nft", "list", "ruleset"], timeout=20)
    validate_firewall_rules(output)
    source = Path(args.source).resolve(strict=True)
    if source != Path(args.source) or not source.is_dir():
        raise GuestError("candidate snapshot path is not canonical")
    if WORK.exists() or WORK.is_symlink():
        raise GuestError("candidate path already exists")
    verify_snapshot(source, args.expected_base, args.expected_head)
    shutil.copytree(source, WORK, symlinks=True)
    user = pwd.getpwnam(USER)
    for path in [WORK, *WORK.rglob("*")]:
        if path.is_symlink():
            continue
        os.chown(path, user.pw_uid, user.pw_gid)
    os.chmod(WORK, 0o700)
    verify_snapshot(WORK, args.expected_base, args.expected_head)
    emit(status="candidate_staged", source_head=args.expected_head)


def verify_snapshot(workspace: Path, base: str, head: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base) or not re.fullmatch(
        r"[0-9a-f]{40}|[0-9a-f]{64}", head
    ):
        raise GuestError("snapshot revisions are invalid")
    output = run([
        sys.executable, str(WORKSPACE_HELPER), "verify", "--workspace", str(workspace),
    ], timeout=120, output_limit=2 * 1024 * 1024)
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise GuestError("trusted snapshot verifier returned invalid JSON") from error
    source = result.get("source", {}) if isinstance(result, dict) else {}
    if (not isinstance(result, dict) or result.get("status") != "verified"
            or source.get("base") != base or source.get("head") != head):
        raise GuestError("guest snapshot does not match exact base/head")


def verify_candidate_boundary():
    user = pwd.getpwnam(USER)
    groups = run(["id", "-nG", USER]).split()
    if (user.pw_uid == 0 or user.pw_gid == 0 or any(
        group in {"sudo", "docker", "podman", "lxd", "disk", "root"} for group in groups
    )):
        raise GuestError("candidate account has privileged groups")
    for socket_path in (Path("/run/podman/podman.sock"), Path("/var/run/docker.sock")):
        if socket_path.exists():
            probe = subprocess.run(
                ["/usr/sbin/runuser", "-u", USER, "--", "/usr/bin/test", "-r", str(socket_path)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
            )
            if probe.returncode == 0:
                raise GuestError("candidate account can access a guest container-control socket")
    ssh_dirs = [Path("/root/.ssh"), *Path("/home").glob("*/.ssh")]
    for ssh_dir in ssh_dirs:
        if not ssh_dir.exists():
            continue
        check = subprocess.run(
            ["/usr/sbin/runuser", "-u", USER, "--", "/usr/bin/test", "-r", str(ssh_dir)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
        if check.returncode == 0:
            raise GuestError("candidate account can read a guest SSH credential directory")
    sudo_probe = subprocess.run(
        ["/usr/sbin/runuser", "-u", USER, "--", "sudo", "-n", "true"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
    )
    if sudo_probe.returncode == 0:
        raise GuestError("candidate account can invoke sudo")
    return True


def start_database(args):
    if os.geteuid() != 0:
        raise GuestError("PostgreSQL provisioning requires guest root")
    image = args.postgres_image
    if not re.fullmatch(r"postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", image):
        raise GuestError("PostgreSQL image is not a trusted digest pin")
    run_id = secrets.token_hex(16)
    db = "jarvis_issue8_" + run_id
    user = "jv" + run_id
    password = secrets.token_hex(32)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    DB_ENV.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    name = DB_NAME_PREFIX + run_id
    identity = ROOT / "postgres-container"
    image_id = None
    container_attempted = False
    exact_container_removed = False
    try:
        DB_ENV.write_text(f"POSTGRES_USER={user}\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB={db}\n", encoding="ascii")
        DB_ENV.chmod(0o600)
        DB_URL.write_text(f"postgresql://{user}:{password}@127.0.0.1:5432/{db}\n", encoding="ascii")
        DB_URL.chmod(0o600)
        marker_fd = os.open(DB_ATTEMPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(marker_fd, "w", encoding="ascii") as marker:
            marker.write(name + "\n")
        image_id = inspect_image(image)
        container_attempted = True
        container_id = run(["podman", "run", "--name", name, "--label", "jarvis.issue214.run=" + run_id,
                            "--network=host", "--detach", "--env-file", str(DB_ENV),
                            image, "-c", "listen_addresses=127.0.0.1"], timeout=120)
        if not re.fullmatch(r"[0-9a-f]{64}", container_id):
            raise GuestError("Podman did not return one exact container ID")
        record = {"schema": 1, "name": name, "run_id": run_id, "container_id": container_id,
                  "image_id": image_id, "digest": image.split("@", 1)[1]}
        descriptor = os.open(identity, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as output:
            json.dump(record, output, sort_keys=True)
            output.write("\n")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            result = subprocess.run(
                ["podman", "exec", "--env-file", str(DB_ENV),
                 name, "sh", "-c", "PGPASSWORD=$POSTGRES_PASSWORD pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False,
            )
            if result.returncode == 0:
                emit(status="postgres_ready", instance=name, image=image)
                return
            time.sleep(1)
        raise GuestError("pinned guest-local PostgreSQL did not become ready")
    except BaseException:
        # If Podman created the container but its command timed out before
        # returning the ID, inspect and remove only a matching generated label,
        # name, and pinned image ID. Ambiguity leaves the whole VM cleanup gate
        # failed rather than sweeping a prefix.
        if container_attempted:
            try:
                inspected = subprocess.run(
                    ["podman", "inspect", "--format",
                     "{{.Id}} {{.Image}} {{index .Config.Labels \"jarvis.issue214.run\"}}", name],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                    timeout=20, check=False,
                )
                parts = inspected.stdout.strip().split()
                if (inspected.returncode == 0 and len(parts) == 3
                        and re.fullmatch(r"[0-9a-f]{64}", parts[0])
                        and parts[1] == image_id and parts[2] == run_id):
                    subprocess.run(["podman", "rm", "--force", "--volumes", parts[0]],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   timeout=30, check=True)
                    exact_container_removed = True
                elif inspected.returncode == 0:
                    raise GuestError("failed startup left an unverified PostgreSQL container")
                else:
                    # A failed inspect is not proof of absence. Preserve the
                    # attempt marker and credentials for exact-VM handoff.
                    raise GuestError("failed startup container cleanup is uncertain")
            except (OSError, subprocess.SubprocessError) as error:
                raise GuestError("failed startup container cleanup is uncertain") from error
        for path in (identity, DB_ATTEMPT, DB_ENV, DB_URL):
            if container_attempted and not exact_container_removed:
                # Only erase credentials after proving/removing the exact
                # attempted container. Uncertain cleanup intentionally retains
                # the marker so final guest cleanup refuses a false success.
                continue
            path.unlink(missing_ok=True)
        raise


def inspect_image(image):
    output = run(["podman", "image", "inspect", "--format", "{{.Id}} {{json .RepoDigests}}", image], timeout=30)
    try:
        image_id, digests_json = output.split(" ", 1)
        digests = json.loads(digests_json)
    except (ValueError, json.JSONDecodeError) as error:
        raise GuestError("pinned PostgreSQL image metadata is invalid") from error
    digest = image.split("@", 1)[1]
    if (not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
            or not isinstance(digests, list)
            or not any(value.endswith("@" + digest) for value in digests)):
        raise GuestError("Podman image is not the trusted digest")
    return image_id


def run_candidate(args):
    if os.geteuid() != 0:
        raise GuestError("candidate execution controller requires guest root")
    output = run(["nft", "list", "ruleset"], timeout=20)
    validate_firewall_rules(output)
    verify_candidate_boundary()
    verify_snapshot(WORK, args.expected_base, args.expected_head)
    candidate_cmd = ["pnpm", "--filter", "@jarvis/persistence", "test"]
    tool_env = {
        "HOME": str(HOME), "PATH": "/usr/local/bin:/opt/jv214-node/bin:/usr/bin:/bin",
        "PNPM_STORE_DIR": str(STORE),
        "npm_config_store_dir": str(STORE), "NPM_CONFIG_USERCONFIG": "/dev/null",
        "NPM_CONFIG_GLOBALCONFIG": "/dev/null", "npm_config_ignore_scripts": "true",
        "LC_ALL": "C",
    }
    run(["/usr/sbin/runuser", "-u", USER, "--", "/usr/bin/env",
         *[f"{key}={value}" for key, value in tool_env.items()],
         "pnpm", "--offline", "--store-dir", str(STORE), "install", "--frozen-lockfile", "--ignore-scripts"],
        cwd=WORK, timeout=MAX_SETUP_SECONDS,
        env={"HOME": "/root", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
        output_limit=MAX_OUTPUT)
    log = TEST_LOG
    log.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    unit = "jv214-test-" + secrets.token_hex(8)
    unit_fd = os.open(CANDIDATE_UNIT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(unit_fd, "w", encoding="ascii") as unit_file:
        unit_file.write(unit + "\n")

    command = [
        "systemd-run", "--unit", unit, "--wait", "--pipe", "--uid", USER,
        "--property=MemoryMax=4G", "--property=CPUQuota=400%", "--property=TasksMax=256",
        f"--property=LimitFSIZE={MAX_OUTPUT}", "--property=LimitNOFILE=256",
        "--property=LimitNPROC=256", f"--property=RuntimeMaxSec={MAX_TEST_SECONDS}",
        "--property=KillMode=control-group", f"--property=EnvironmentFile={Path('/run/jv214/candidate.env')}",
        "--working-directory", str(WORK), "--", "/usr/bin/env",
        f"HOME={HOME}", "PATH=/usr/local/bin:/opt/jv214-node/bin:/usr/bin:/bin",
        f"PNPM_STORE_DIR={STORE}",
        f"npm_config_store_dir={STORE}", "NPM_CONFIG_USERCONFIG=/dev/null",
        "NPM_CONFIG_GLOBALCONFIG=/dev/null", "npm_config_ignore_scripts=true", "LC_ALL=C",
        *candidate_cmd,
    ]
    process = None
    timed_out = False
    started = time.monotonic()
    url = DB_URL.read_text(encoding="ascii").strip()
    if not url.startswith("postgresql://") or "@127.0.0.1:5432/" not in url:
        raise GuestError("guest PostgreSQL URL is not loopback-only")
    env_file = CANDIDATE_ENV
    env_file.write_text(
        f"JARVIS_TEST_DATABASE_URL={url}\nJARVIS_RUN_STOP_RUNTIME_INTEGRATION=1\n", encoding="ascii",
    )
    env_file.chmod(0o600)

    def stop_unit():
        result = subprocess.run(["systemctl", "stop", unit + ".service"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=30, check=False)
        if result.returncode:
            # A unit may not have been created; the subsequent state check
            # determines whether cleanup is safe.
            return

    try:
        with os.fdopen(descriptor, "wb") as output:
            _unused_output, returncode = run_bounded(
                command, timeout=MAX_TEST_SECONDS + 120,
                env={"HOME": "/root", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                output_limit=MAX_OUTPUT, output_file=output, on_terminate=stop_unit,
            )
        process_returncode = returncode
        status = subprocess.run(["systemctl", "show", "--property=ActiveState", "--value", unit + ".service"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                timeout=10, check=False)
        if status.returncode == 0 and status.stdout.strip() not in {"inactive", "failed"}:
            raise GuestError("candidate systemd unit remains active")
    except BaseException:
        if process is not None and process.poll() is None:
            try:
                subprocess.run(["systemctl", "stop", unit + ".service"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=20, check=False)
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
            except (OSError, subprocess.SubprocessError):
                raise GuestError("candidate process termination is uncertain")
        raise
    finally:
        env_file.unlink(missing_ok=True)

    content = log.read_text(encoding="utf-8", errors="replace")
    summary, scenarios, success = parse_test_output(content, process_returncode, timed_out)
    emit(status="candidate_result", exit_code=process_returncode, timed_out=timed_out,
         duration_seconds=round(time.monotonic() - started, 3), summary=summary,
         required_scenarios=scenarios, passed=success)


def parse_test_output(content, exit_code, timed_out):
    scenario_names = (
        "real PostgreSQL stop controls gate and cancel the real queue worker composition",
        "persisted stop state survives an operating-system worker restart",
    )
    scenarios = []
    for name in scenario_names:
        lines = [line.strip() for line in content.splitlines()
                 if name in line and (line.strip().startswith(("ok ", "not ok ", "✔ ", "✖ ", "﹣ ")))]
        if len(lines) != 1:
            result = "missing_or_ambiguous"
        elif "# SKIP" in lines[0] or lines[0].startswith("﹣ "):
            result = "skipped"
        elif lines[0].startswith(("not ok ", "✖ ")):
            result = "failed"
        else:
            result = "passed"
        scenarios.append({"name": name, "result": result})
    summary = {}
    for key, label in (("tests", "total"), ("pass", "pass"), ("fail", "fail"), ("skipped", "skip")):
        matches = re.findall(rf"^\s*(?:ℹ|#)\s*{key}\s+(\d+)\s*$", content, re.M)
        summary[label] = int(matches[-1]) if matches else None
    success = (exit_code == 0 and not timed_out and summary["total"] is not None
               and summary["pass"] is not None and summary["fail"] is not None
               and summary["skip"] is not None
               and summary["pass"] + summary["fail"] + summary["skip"] == summary["total"]
               and summary["fail"] == 0 and summary["skip"] == 0
               and all(x["result"] == "passed" for x in scenarios))
    return summary, scenarios, success


def finish_candidate(args):
    if os.geteuid() != 0:
        raise GuestError("snapshot finalization requires guest root")
    allowed = [WORK / "node_modules", *WORK.glob("apps/*/node_modules"),
               *WORK.glob("packages/*/node_modules"), WORK / "apps/api/dist",
               WORK / "apps/worker/dist", WORK / "packages/domain/dist",
               WORK / "packages/queue/dist", WORK / "packages/persistence/dist"]
    for path in allowed:
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise GuestError("generated candidate output path changed identity")
        if path.exists():
            shutil.rmtree(path)
    verify_snapshot(WORK, args.expected_base, args.expected_head)
    emit(status="snapshot_verified_after_test", head=args.expected_head)


def cleanup(args):
    if os.geteuid() != 0:
        raise GuestError("cleanup requires guest root")
    errors = []
    identity = ROOT / "postgres-container"
    unit_name = ""
    try:
        unit_name = CANDIDATE_UNIT.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        pass
    if unit_name:
        if not re.fullmatch(r"jv214-test-[0-9a-f]{16}", unit_name):
            raise GuestError("recorded candidate unit identity is invalid")
        subprocess.run(["systemctl", "stop", unit_name + ".service"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
        state = subprocess.run(["systemctl", "show", "--property=ActiveState", "--value",
                                unit_name + ".service"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, timeout=10, check=False)
        if state.returncode or state.stdout.strip() not in {"inactive", "failed"}:
            raise GuestError("candidate process unit remains active; refusing cleanup")

    identity_present = identity.exists() or identity.is_symlink()
    attempt_present = DB_ATTEMPT.exists() or DB_ATTEMPT.is_symlink()
    if identity.is_symlink() or DB_ATTEMPT.is_symlink():
        raise GuestError("database identity path is a symlink; refusing cleanup")
    attempt = ""
    if attempt_present:
        attempt = DB_ATTEMPT.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"jv214-pg-[0-9a-f]{32}", attempt):
            raise GuestError("database attempt marker is invalid")
    if identity_present:
        info = identity.stat()
        if (info.st_uid != 0 or info.st_mode & 0o777 != 0o600 or not identity.is_file()
                or identity.parent.stat().st_uid != 0
                or identity.parent.stat().st_mode & 0o022):
            raise GuestError("stored PostgreSQL identity is not root-owned and protected")
        try:
            record = json.loads(identity.read_text(encoding="ascii"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GuestError("stored PostgreSQL identity is malformed") from error
        if not isinstance(record, dict):
            raise GuestError("stored PostgreSQL identity is malformed")
        name, run_id = record.get("name"), record.get("run_id")
        container_id, stored_image_id = record.get("container_id"), record.get("image_id")
        expected_digest = args.postgres_image.split("@", 1)[1]
        if (not re.fullmatch(r"[0-9a-f]{32}", str(run_id))
                or name != DB_NAME_PREFIX + run_id
                or not attempt_present or attempt != name
                or not re.fullmatch(r"[0-9a-f]{64}", str(container_id))
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(stored_image_id))
                or record.get("digest") != expected_digest):
            raise GuestError("stored PostgreSQL identity does not match this run and pin")
        current_image_id = inspect_image(args.postgres_image)
        inspect = run(["podman", "inspect", "--format",
                       "{{.Id}} {{.Image}} {{index .Config.Labels \"jarvis.issue214.run\"}}",
                       container_id], timeout=30)
        try:
            actual_container_id, actual_image_id, actual_run_id = inspect.split()
        except ValueError as error:
            raise GuestError("Podman returned malformed container identity") from error
        if (actual_container_id != container_id or actual_image_id != stored_image_id
                or actual_image_id != current_image_id or actual_run_id != run_id):
            raise GuestError("PostgreSQL container identity mismatch; left untouched")
        run(["podman", "rm", "--force", "--volumes", container_id], timeout=60)
    elif attempt_present or DB_ENV.exists() or DB_URL.exists():
        raise GuestError("database setup was attempted but exact container identity is unavailable")

    for path in (identity, DB_ATTEMPT, DB_ENV, DB_URL, CANDIDATE_ENV, TEST_LOG, CANDIDATE_UNIT):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            errors.append("guest credential or output cleanup failed")
    if errors:
        raise GuestError("; ".join(errors))
    emit(status="guest_cleanup_complete")


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    bootstrap = sub.add_parser("bootstrap")
    bootstrap.add_argument("--node-version", required=True)
    bootstrap.add_argument("--pnpm-version", required=True)
    bootstrap.add_argument("--pnpm-integrity", required=True)
    bootstrap.add_argument("--postgres-image", required=True)
    bootstrap.add_argument("--trusted-workspace", required=True)
    sub.add_parser("firewall")
    sub.add_parser("qualification-prepare")
    probe = sub.add_parser("probe")
    probe.add_argument("--host-ip", required=True)
    probe.add_argument("--host-canary-port", type=int, required=True)
    probe.add_argument("--lan-ip", required=True)
    probe.add_argument("--lan-canary-port", type=int, required=True)
    probe.add_argument("--host-forward-port", type=int, required=True)
    probe.add_argument("--gateway-ip", required=True)
    probe.add_argument("--other-guest-ip", required=True)
    stage = sub.add_parser("stage")
    stage.add_argument("--source", required=True)
    stage.add_argument("--expected-base", required=True)
    stage.add_argument("--expected-head", required=True)
    database = sub.add_parser("database")
    database.add_argument("--postgres-image", required=True)
    test = sub.add_parser("test")
    test.add_argument("--expected-base", required=True)
    test.add_argument("--expected-head", required=True)
    finish = sub.add_parser("finish")
    finish.add_argument("--expected-base", required=True)
    finish.add_argument("--expected-head", required=True)
    cleanup_parser = sub.add_parser("cleanup")
    cleanup_parser.add_argument("--postgres-image", required=True)
    args = parser.parse_args(argv)
    try:
        {
            "bootstrap": install_toolchain,
            "firewall": firewall_install,
            "qualification-prepare": qualification_prepare,
            "probe": probe_network,
            "stage": install_candidate,
            "database": start_database,
            "test": run_candidate,
            "finish": finish_candidate,
            "cleanup": cleanup,
        }[args.action](args)
    except (GuestError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        emit(status="failed", error=str(error))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
