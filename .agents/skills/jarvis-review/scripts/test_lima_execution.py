"""Mocked unit coverage for the issue-214 Lima profile contract."""

import json
from pathlib import Path
import tempfile
import unittest

import lima_execution as lima


class LimaProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / ("jarvis-issue214-" + "a" * 32)
        self.directory.mkdir()
        self.name = self.directory.name
        self.record = {
            "name": self.name,
            "status": "Running",
            "dir": str(self.directory),
            "sshAddress": "127.0.0.1",
            "config": {
                "vmType": "vz", "arch": "aarch64", "cpus": 4,
                "memory": "8GiB", "disk": "40GiB", "plain": True,
                "propagateProxyEnv": False, "mounts": None, "portForwards": None,
                "images": [{"arch": "aarch64", "digest": "sha256:" + "a" * 64,
                            "location": "https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img"}],
                "ssh": {"forwardAgent": False, "forwardX11": False},
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_instance_name_and_create_arguments_are_fixed_and_bounded(self):
        name = lima.instance_name("a" * 32)
        self.assertEqual(name, self.name)
        args = lima.create_arguments(name)
        self.assertIn("--plain", args)
        self.assertIn("--mount-none", args)
        self.assertIn("--vm-type", args)
        self.assertIn("--arch", args)
        self.assertIn("--cpus", args)
        self.assertIn("--memory", args)
        self.assertIn("--disk", args)
        self.assertIn("--set=.propagateProxyEnv = false", args)
        self.assertIn("--set=.ssh.forwardAgent = false", args)
        with self.assertRaises(lima.LimaValidationError):
            lima.instance_name("../candidate")

    def test_json_lines_parser_rejects_malformed_and_duplicate_instances(self):
        self.assertEqual(lima.parse_list_json(json.dumps(self.record))[0]["name"], self.name)
        with self.assertRaises(lima.LimaValidationError):
            lima.parse_list_json("not json")
        with self.assertRaises(lima.LimaValidationError):
            lima.parse_list_json("\n".join((json.dumps(self.record), json.dumps(self.record))))

    def test_effective_instance_profile_passes_and_unsafe_changes_fail(self):
        self.record["config"]["images"].append({
            "arch": "aarch64", "location": "https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-arm64.img",
        })
        self.assertEqual(lima.validate_instance(self.record, self.name), self.directory)
        for path, value in (
            (("config", "propagateProxyEnv"), True),
            (("config", "plain"), False),
            (("config", "mounts"), ["/Users:/Users"]),
            (("config", "portForwards"), [{"guestPort": 5432}]),
            (("config", "ssh", "forwardAgent"), True),
            (("config", "arch"), "x86_64"),
            (("config", "images"), [{"arch": "aarch64", "location": "mutable.img"}]),
            (("sshAddress",), "0.0.0.0"),
        ):
            record = json.loads(json.dumps(self.record))
            target = record
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(lima.LimaValidationError):
                lima.validate_instance(record, self.name)
        unsafe = json.loads(json.dumps(self.record))
        unsafe["config"]["images"].reverse()
        with self.assertRaises(lima.LimaValidationError):
            lima.validate_instance(unsafe, self.name)

    def test_instance_cleanup_requires_exact_unique_identity(self):
        self.assertIs(lima.teardown_identity([self.record], self.name, self.directory), self.record)
        with self.assertRaises(lima.LimaValidationError):
            lima.teardown_identity([], self.name, self.directory)
        with self.assertRaises(lima.LimaValidationError):
            lima.teardown_identity([self.record, self.record], self.name, self.directory)
        wrong = json.loads(json.dumps(self.record))
        wrong["dir"] = str(self.directory.parent / "wrong-instance")
        with self.assertRaises(lima.LimaValidationError):
            lima.teardown_identity([wrong], self.name, self.directory)

    def test_firewall_policy_is_explicit_deny_by_default_with_limited_ssh(self):
        rules = lima.firewall_rules()
        self.assertIn("policy drop", rules)
        self.assertIn("ip saddr 192.168.5.2 tcp dport 22 ct state new accept", rules)
        self.assertNotIn("policy accept", rules)
        rendered = rules.replace("priority 0", "priority filter")
        lima.validate_firewall_rules(rendered)
        with self.assertRaises(lima.LimaValidationError):
            lima.validate_firewall_rules(rendered.replace("policy drop", "policy accept", 1))
        with self.assertRaises(lima.LimaValidationError):
            lima.validate_firewall_rules(rendered.replace("192.168.5.2", "0.0.0.0"))
        with self.assertRaises(lima.LimaValidationError):
            lima.validate_firewall_rules(rendered.replace(
                "chain output {", "chain output {\n\t\tip daddr 8.8.8.8 accept",
            ))

    def test_isolation_evidence_requires_all_ipv4_and_firewall_checks(self):
        probes = {
            "ipv4": {key: "blocked" for key in (
                "host_loopback", "host_lan", "host_ssh", "hostagent_forward", "lan_gateway",
                "public_ipv4", "ipv4_dns", "other_instance",
            )},
            "ipv6": "no_route",
            "firewall_change_as_candidate_user": "denied",
        }
        lima.validate_isolation_probes(probes)
        probes["ipv4"]["other_instance"] = "reachable"
        with self.assertRaises(lima.LimaValidationError):
            lima.validate_isolation_probes(probes)

    def test_only_persistence_test_and_credential_free_base_environment(self):
        self.assertEqual(lima.candidate_test_command(), ["pnpm", "--filter", "@jarvis/persistence", "test"])
        env = lima.safe_environment(Path("/guest/home"), Path("/guest/store"), node_bin=Path("/opt/node/bin"))
        self.assertNotIn("JARVIS_TEST_DATABASE_URL", env)
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertEqual(env["npm_config_ignore_scripts"], "true")
        self.assertEqual(env["PNPM_STORE_DIR"], "/guest/store")


if __name__ == "__main__":
    unittest.main()
