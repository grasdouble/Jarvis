"""Fail-closed primitives for the issue-214 Lima persistence runner.

This module builds/validates the Lima profile and guest firewall contract. It
does not invoke candidate commands and is not, by itself, an isolation boundary.
"""

from __future__ import annotations

import re
from pathlib import Path


INSTANCE_PREFIX = "jarvis-issue214-"
HOST_SSH_SOURCE = "192.168.5.2"
CPU_LIMIT = 4
MEMORY_GIB = 8
DISK_GIB = 40
MAX_TEST_SECONDS = 20 * 60
MAX_SETUP_SECONDS = 10 * 60
MAX_OUTPUT_BYTES = 32 * 1024 * 1024


class LimaValidationError(Exception):
    """A Lima instance or guest profile failed a required safety check."""


def instance_name(run_id: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        raise LimaValidationError("run ID must be 32 lowercase hexadecimal characters")
    return INSTANCE_PREFIX + run_id


def create_arguments(name: str) -> list[str]:
    if not re.fullmatch(r"jarvis-issue214-[0-9a-f]{32}", name):
        raise LimaValidationError("instance name is not an issue-214 run identity")
    return [
        "create", "--name", name, "--tty=false", "--plain", "--mount-none",
        "--vm-type", "vz", "--arch", "aarch64", "--cpus", str(CPU_LIMIT),
        "--memory", str(MEMORY_GIB), "--disk", str(DISK_GIB),
        "--set=.propagateProxyEnv = false", "--set=.ssh.forwardAgent = false",
        "template:ubuntu-24.04",
    ]


def parse_list_json(output: str) -> list[dict]:
    """Parse limactl's JSON-lines output, rejecting malformed/duplicate names."""
    records = []
    names = set()
    for line in output.splitlines():
        if not line.strip():
            continue
        import json

        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise LimaValidationError("limactl returned invalid instance JSON") from error
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            raise LimaValidationError("limactl returned an invalid instance record")
        if record["name"] in names:
            raise LimaValidationError("limactl returned duplicate instance identities")
        names.add(record["name"])
        records.append(record)
    return records


def validate_instance(record: dict, name: str, *, expected_dir: Path | None = None,
                      require_running: bool = True) -> Path:
    """Check the exact instance and all isolation-relevant effective settings."""
    if record.get("name") != name or not name.startswith(INSTANCE_PREFIX):
        raise LimaValidationError("Lima instance identity does not match this run")
    if require_running and record.get("status") != "Running":
        raise LimaValidationError("Lima instance is not running")
    config = record.get("config")
    if not isinstance(config, dict):
        raise LimaValidationError("Lima did not report effective instance configuration")
    ssh = config.get("ssh")
    if not isinstance(ssh, dict):
        raise LimaValidationError("Lima SSH settings are unavailable")
    images = config.get("images")
    arm_image = [image for image in images if isinstance(image, dict)
                 and image.get("arch") == "aarch64"
                 and isinstance(image.get("location"), str)
                 and "ubuntu-24.04-server-cloudimg-arm64.img" in image["location"]] if isinstance(images, list) else []
    # Lima's template lists a dated image first and an unversioned fallback
    # later. Lima selects the first architecture match; require that selected
    # entry, not every unused fallback, to be digest-pinned.
    selected_image = arm_image[0] if arm_image else {}
    if (not isinstance(selected_image.get("digest"), str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", selected_image["digest"])):
        raise LimaValidationError("Lima ARM64 guest image is not immutably digest-pinned")
    if (config.get("vmType") != "vz" or config.get("arch") != "aarch64"
            or config.get("cpus") != CPU_LIMIT or config.get("memory") != f"{MEMORY_GIB}GiB"
            or config.get("disk") != f"{DISK_GIB}GiB" or config.get("plain") is not True
            or config.get("propagateProxyEnv") is not False
            or ssh.get("forwardAgent") is not False
            or ssh.get("forwardX11") is not False
            or config.get("mounts") not in (None, [])
            or config.get("portForwards") not in (None, [])):
        raise LimaValidationError("Lima effective configuration violates the isolated profile")
    if record.get("sshAddress") != "127.0.0.1":
        raise LimaValidationError("Lima SSH endpoint is not host-loopback only")
    directory = record.get("dir")
    if not isinstance(directory, str) or not directory:
        raise LimaValidationError("Lima instance directory is missing")
    original_path = Path(directory)
    if original_path.is_symlink():
        raise LimaValidationError("Lima instance directory is a symlink")
    try:
        path = original_path.resolve(strict=True)
    except OSError as error:
        raise LimaValidationError("Lima instance directory cannot be resolved safely") from error
    if path.name != name or not path.is_dir():
        raise LimaValidationError("Lima instance directory identity is unsafe")
    if expected_dir is not None and path != expected_dir.resolve(strict=True):
        raise LimaValidationError("Lima instance directory changed identity")
    return path


def firewall_rules() -> str:
    """Root-installed nftables policy preserving only controller SSH and replies."""
    return f"""table inet jarvis_guard {{
  chain input {{
    type filter hook input priority 0; policy drop;
    iifname \"lo\" accept
    ct state established,related accept
    ip saddr {HOST_SSH_SOURCE} tcp dport 22 ct state new accept
  }}
  chain output {{
    type filter hook output priority 0; policy drop;
    oifname \"lo\" accept
    ct state established,related accept
  }}
  chain forward {{
    type filter hook forward priority 0; policy drop;
  }}
}}
"""


def validate_firewall_rules(output: str) -> None:
    """Require all default-drop chains and the narrowly scoped SSH exception."""
    actual = []
    for line in output.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            actual.append(" ".join(line.split()))
    expected = [
        "table inet jarvis_guard {",
        "chain input {",
        "type filter hook input priority filter; policy drop;",
        'iifname "lo" accept',
        "ct state established,related accept",
        f"ip saddr {HOST_SSH_SOURCE} tcp dport 22 ct state new accept",
        "}",
        "chain output {",
        "type filter hook output priority filter; policy drop;",
        'oifname "lo" accept',
        "ct state established,related accept",
        "}",
        "chain forward {",
        "type filter hook forward priority filter; policy drop;",
        "}",
        "}",
    ]
    if actual != expected:
        raise LimaValidationError("guest nftables rules do not match the required deny-egress policy")


def validate_isolation_probes(results: dict) -> None:
    """Require direct IPv4 denies, denied guest firewall edits, and explicit IPv6 status."""
    required = {
        "host_loopback", "host_lan", "host_ssh", "hostagent_forward", "lan_gateway",
        "public_ipv4", "ipv4_dns", "other_instance",
    }
    probes = results.get("ipv4")
    if not isinstance(probes, dict) or not required.issubset(probes):
        raise LimaValidationError("the required guest isolation probes are incomplete")
    if any(probes[name] != "blocked" for name in required):
        raise LimaValidationError("a guest IPv4 isolation probe was not blocked")
    if results.get("firewall_change_as_candidate_user") != "denied":
        raise LimaValidationError("candidate user was able to change the guest firewall")
    if results.get("ipv6") not in {"blocked", "no_route"}:
        raise LimaValidationError("IPv6 isolation state is unknown")


def candidate_test_command() -> list[str]:
    """The sole repository test invocation authorized for issue #214."""
    return ["pnpm", "--filter", "@jarvis/persistence", "test"]


def safe_environment(home: Path, store: Path, *, node_bin: Path) -> dict[str, str]:
    """Return a credential-free tool environment; the guest adds DB URL in-guest."""
    return {
        "HOME": str(home),
        "PATH": f"/usr/local/bin:{node_bin}:/usr/bin:/bin",
        "COREPACK_HOME": str(home / ".corepack"),
        "PNPM_STORE_DIR": str(store),
        "npm_config_store_dir": str(store),
        "NPM_CONFIG_USERCONFIG": "/dev/null",
        "NPM_CONFIG_GLOBALCONFIG": "/dev/null",
        "npm_config_ignore_scripts": "true",
        "LC_ALL": "C",
    }


def teardown_identity(records: list[dict], name: str, expected_dir: Path) -> dict:
    """Return the only instance record safe to stop/delete, else fail closed."""
    matches = [record for record in records if record.get("name") == name]
    if len(matches) != 1:
        raise LimaValidationError("run instance is missing or ambiguous; refusing cleanup")
    record = matches[0]
    validate_instance(record, name, expected_dir=expected_dir, require_running=False)
    return record
