"""Tests for the host-side Colima bootstrap contract."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra" / "colima"


class ColimaBootstrapTests(unittest.TestCase):
    def test_profile_disables_host_shares_and_context_activation(self):
        config_path = INFRA / "colima.yaml"
        self.assertTrue(config_path.is_file(), "the dedicated Colima profile must be checked in")
        config = config_path.read_text()
        self.assertRegex(config, r"(?m)^runtime:\s*docker\s*$")
        self.assertRegex(config, r"(?m)^arch:\s*aarch64\s*$")
        self.assertRegex(config, r"(?m)^mounts:\s*null\s*$")
        self.assertRegex(config, r"(?m)^forwardAgent:\s*false\s*$")
        self.assertRegex(config, r"(?m)^autoActivate:\s*false\s*$")
        self.assertRegex(config, r"(?m)^cpu:\s*4\s*$")
        self.assertRegex(config, r"(?m)^memory:\s*8\s*$")
        self.assertRegex(config, r"(?m)^disk:\s*80\s*$")

    def test_version_manifest_pins_host_tools_and_guest_engine(self):
        values = {}
        for line in (INFRA / "versions.env").read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
        self.assertEqual(values["COLIMA_VERSION"], "0.10.3")
        self.assertEqual(values["LIMA_VERSION"], "2.2.1")
        self.assertEqual(values["DOCKER_CLI_VERSION"], "29.9.1")
        self.assertEqual(values["DOCKER_CLI_COMPATIBLE_MAJOR"], "29")
        self.assertEqual(values["DOCKER_ENGINE_VERSION"], "29.5.2")
        self.assertEqual(values["DOCKER_ENGINE_API_VERSION"], "1.54")
        self.assertEqual(values["COMPOSE_VERSION"], "5.6.0")
        self.assertRegex(values["COMPOSE_SHA256"], r"^[0-9a-f]{64}$")
        self.assertIn("@sha256:", values["POSTGRES_IMAGE"])
        self.assertEqual(values["POSTGRES_PLATFORM"], "linux/arm64")

    def test_compose_uses_a_pinned_arm64_image_without_host_ports(self):
        compose = (ROOT / "infra" / "compose" / "compose.yaml").read_text()
        values = {}
        for line in (INFRA / "versions.env").read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value.strip().strip('"')
        self.assertIn(f'image: {values["POSTGRES_IMAGE"]}', compose)
        self.assertIn("platform: linux/arm64", compose)
        self.assertIn("file: /etc/jarvis/secrets/postgres_password", compose)
        self.assertNotRegex(compose, r"(?m)^\s+ports:")
        self.assertIn("internal: true", compose)

    def test_engine_socket_is_attached_only_to_the_restricted_manager(self):
        import yaml

        compose = yaml.safe_load((ROOT / "infra" / "compose" / "compose.yaml").read_text())
        services = compose["services"]
        socket_mounts = [
            name
            for name, service in services.items()
            for mount in service.get("volumes", [])
            if isinstance(mount, dict) and mount.get("source") == "/var/run/docker.sock"
        ]
        self.assertEqual(socket_mounts, ["sandbox-manager"])
        manager = services["sandbox-manager"]
        self.assertEqual(manager["profiles"], ["sandbox-manager"])
        self.assertEqual(manager["user"], "10001:10001")
        self.assertEqual(manager["cap_drop"], ["ALL"])
        self.assertTrue(manager["read_only"])
        self.assertNotIn("ports", manager)
        self.assertIn("core", manager["networks"])
        self.assertNotIn("worker", services)
        self.assertNotIn("agent", services)

    def test_manager_image_uses_an_arm64_digest_pinned_node_base(self):
        dockerfile = (ROOT / "infra" / "sandbox-manager" / "Dockerfile").read_text()
        self.assertRegex(dockerfile, r"(?m)^FROM node:24\.22\.0-bookworm-slim@sha256:[0-9a-f]{64}$")
        self.assertIn("USER 10001:10001", dockerfile)
        dockerignore = (ROOT / ".dockerignore").read_text().splitlines()
        self.assertIn("**", dockerignore)
        self.assertIn("!apps/sandbox-manager/dist/**", dockerignore)

    def test_preflight_accepts_compatible_docker_cli_versions_and_reports_pins(self):
        script = INFRA / "bootstrap.sh"
        with tempfile.TemporaryDirectory() as temporary:
            fake_bin = Path(temporary)
            self._write_command(fake_bin, "uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
            self._write_command(fake_bin, "sw_vers", 'echo 27.0.1')
            self._write_command(fake_bin, "sysctl", 'echo "${TEST_MEMORY_BYTES:-34359738368}"')
            self._write_command(fake_bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mock 100000000 1 %s 1%% /\\n" "${TEST_FREE_BLOCKS:-100000000}"')
            self._write_command(fake_bin, "colima", 'echo "colima version ${TEST_COLIMA_VERSION:-0.10.3}"')
            self._write_command(fake_bin, "limactl", 'echo "limactl version ${TEST_LIMA_VERSION:-2.2.1}"')
            self._write_command(fake_bin, "docker", 'echo "Docker version ${TEST_DOCKER_VERSION:-29.9.1}, build mock"')
            for docker_version in ("29.9.1", "29.9.2"):
                with self.subTest(docker_version=docker_version):
                    env = os.environ | {
                        "PATH": f"{fake_bin}:{os.environ['PATH']}",
                        "TEST_DOCKER_VERSION": docker_version,
                    }
                    result = subprocess.run(["bash", str(script), "--check-host"], env=env,
                                            capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("Colima 0.10.3", result.stdout)
                    self.assertIn("Docker CLI major 29 (selected baseline 29.9.1)", result.stdout)
                    self.assertIn("40 GiB", result.stdout)

    def test_preflight_rejects_incompatible_or_malformed_docker_cli_versions(self):
        script = INFRA / "bootstrap.sh"
        with tempfile.TemporaryDirectory() as temporary:
            fake_bin = Path(temporary)
            self._write_command(fake_bin, "uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
            self._write_command(fake_bin, "sw_vers", 'echo 27.0.1')
            self._write_command(fake_bin, "sysctl", 'echo 34359738368')
            self._write_command(fake_bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mock 100000000 1 100000000 1%% /\\n"')
            self._write_command(fake_bin, "colima", 'echo "colima version 0.10.3"')
            self._write_command(fake_bin, "limactl", 'echo "limactl version 2.2.1"')
            self._write_command(fake_bin, "docker", 'printf "Docker version %s, build mock\\n" "${TEST_DOCKER_VERSION}"')
            for docker_version in ("28.9.1", "30.0.0", "unknown", "29.9", "v29.9.1"):
                with self.subTest(docker_version=docker_version):
                    env = os.environ | {
                        "PATH": f"{fake_bin}:{os.environ['PATH']}",
                        "TEST_DOCKER_VERSION": docker_version,
                    }
                    result = subprocess.run(["bash", str(script), "--check-host"], env=env,
                                            capture_output=True, text=True, check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Docker CLI version must be a valid 29.x.y release", result.stderr)
                    self.assertIn(docker_version, result.stderr)

    def test_preflight_rejects_insufficient_host_resources(self):
        script = INFRA / "bootstrap.sh"
        with tempfile.TemporaryDirectory() as temporary:
            fake_bin = Path(temporary)
            self._write_command(fake_bin, "uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
            self._write_command(fake_bin, "sw_vers", 'echo 27.0.1')
            self._write_command(fake_bin, "sysctl", 'printf "%s\\n" "${TEST_MEMORY_BYTES:-34359738368}"')
            self._write_command(fake_bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mock 100000000 1 %s 1%% /\\n" "${TEST_FREE_BLOCKS:-100000000}"')
            self._write_command(fake_bin, "colima", 'printf "colima version %s\\n" "${TEST_COLIMA_VERSION:-0.10.3}"')
            self._write_command(fake_bin, "limactl", 'printf "limactl version %s\\n" "${TEST_LIMA_VERSION:-2.2.1}"')
            self._write_command(fake_bin, "docker", 'printf "Docker version %s, build mock\\n" "${TEST_DOCKER_VERSION:-29.9.1}"')
            env = os.environ | {"PATH": f"{fake_bin}:{os.environ['PATH']}", "TEST_FREE_BLOCKS": "100"}
            result = subprocess.run(["bash", str(script), "--check-host"], env=env,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("40 GiB", result.stderr)

    def test_apply_refuses_to_overwrite_an_existing_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            home = root / "home"
            profile = home / ".colima" / "jarvis"
            profile.mkdir(parents=True)
            marker = profile / "colima.yaml"
            marker.write_text("user-owned configuration\n")
            self._write_command(fake_bin, "uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
            self._write_command(fake_bin, "sw_vers", 'echo 27.0.1')
            self._write_command(fake_bin, "sysctl", 'echo 34359738368')
            self._write_command(fake_bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mock 100000000 1 100000000 1%% /\\n"')
            self._write_command(fake_bin, "colima", 'echo "colima version 0.10.3"')
            self._write_command(fake_bin, "limactl", 'echo "limactl version 2.2.1"')
            self._write_command(fake_bin, "docker", 'echo "Docker version 29.9.1, build mock"')
            env = os.environ | {"PATH": f"{fake_bin}:{os.environ['PATH']}",
                                "HOME": str(home), "COLIMA_HOME": str(home / ".colima")}
            result = subprocess.run(["bash", str(INFRA / "bootstrap.sh"), "--apply"], env=env,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing to change existing Colima profile", result.stderr)
            self.assertEqual(marker.read_text(), "user-owned configuration\n")

    def test_secret_value_is_transferred_only_over_stdin(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            self._write_command(fake_bin, "colima", 'printf "%s\\n" "$*" > "$CAPTURE_ARGS"; cat > "$CAPTURE_STDIN"')
            secret = "fixture-only-secret-do-not-log"
            env = os.environ | {"PATH": f"{fake_bin}:{os.environ['PATH']}",
                                "CAPTURE_ARGS": str(root / "args"),
                                "CAPTURE_STDIN": str(root / "stdin")}
            result = subprocess.run(["bash", str(INFRA / "provision-secret.sh"), "postgres_password"],
                                    input=secret, env=env, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "stdin").read_text(), secret)
            self.assertNotIn(secret, (root / "args").read_text())
            self.assertNotIn(secret, result.stdout + result.stderr)

    @staticmethod
    def _write_command(directory: Path, name: str, body: str):
        command = directory / name
        command.write_text(f"#!/bin/bash\n{body}\n")
        command.chmod(0o755)


if __name__ == "__main__":
    unittest.main()
