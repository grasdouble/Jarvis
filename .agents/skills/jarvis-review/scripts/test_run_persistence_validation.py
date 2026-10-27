import argparse
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).with_name("run_persistence_validation.py")
SPEC = importlib.util.spec_from_file_location("run_persistence_validation", SCRIPT)
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)

BASE = "1" * 40
HEAD = "2" * 40
IMAGE = "postgres:18.6-bookworm@sha256:" + "a" * 64
SUMMARY = "ℹ tests 4\nℹ pass 2\nℹ fail 0\nℹ skipped 2"
SCENARIO_OUTPUT = "\n".join(
    [SUMMARY, *(f"  ✔ {scenario} (12.3ms)" for scenario in validation.INTEGRATION_SCENARIOS)]
)


class PersistenceValidationTests(unittest.TestCase):
    def _arguments(self, workspace, versions):
        return argparse.Namespace(
            workspace=str(workspace), versions=str(versions), expected_base=BASE, expected_head=HEAD,
        )

    def _run_mocked_runner(self, root, *, test_result=None, install_result=None,
                           engine_interrupt=False, process_tree_failure=False,
                           identity_drift=False, revision_mismatch=False,
                           post_test_revision_drift=False, interrupt_during_cleanup=False,
                           unexpected_workspace_output=False):
        workspace = root / "workspace"
        workspace.mkdir()
        versions = root / "versions.env"
        versions.write_text(f"POSTGRES_IMAGE={IMAGE}\nPOSTGRES_PLATFORM=linux/arm64\n", encoding="utf-8")
        docker_config = root / "isolated-docker-config"
        docker_config.mkdir()
        container_id = "b" * 64
        calls, events, managed, lifecycle, command_runs = [], [], [], [], []
        identity = {"run_id": None, "volume": None, "name": None}
        container = {}

        def docker(command, **_kwargs):
            calls.append(command)
            if command[:2] == ["volume", "create"]:
                lifecycle.append("volume_create")
                identity["run_id"] = command[command.index("--label") + 1].split("=", 1)[1]
                identity["volume"] = command[-1]
                return identity["volume"]
            if command[:2] == ["volume", "inspect"]:
                return json.dumps([{
                    "Name": identity["volume"],
                    "Labels": {"org.jarvis.issue214.run": identity["run_id"]},
                }])
            if command[0] == "run":
                identity["name"] = command[command.index("--name") + 1]
                container.update({
                    "Id": container_id,
                    "Name": "/" + identity["name"],
                    "Config": {
                        "Image": IMAGE,
                        "Labels": {"org.jarvis.issue214.run": identity["run_id"]},
                    },
                    "Mounts": [{"Name": identity["volume"], "Type": "volume"}],
                })
                return container_id
            if command[0] == "inspect" and "--format" not in command:
                return json.dumps([container])
            if command[0] == "port":
                return "127.0.0.1:54321"
            if command[0] == "inspect":
                return json.dumps({"Status": "running", "Health": {"Status": "healthy"}})
            if command[:2] == ["rm", "--force"]:
                lifecycle.append("container_cleanup")
                if interrupt_during_cleanup:
                    validation.INTERRUPT_PENDING = True
            if command[:2] == ["volume", "rm"]:
                lifecycle.append("volume_cleanup")
            return ""

        cleanup_calls = {"container": 0, "volume": 0}

        def inspect_owned(kind, identifier):
            cleanup_calls[kind] += 1
            if identity_drift:
                if kind == "container":
                    return {**container, "Config": {"Image": IMAGE, "Labels": {}}}
                return {"Name": identifier, "Labels": {}}
            if cleanup_calls[kind] == 2:
                return None
            if kind == "container":
                return container
            return {"Name": identifier, "Labels": {"org.jarvis.issue214.run": identity["run_id"]}}

        def run_managed(command, *, cwd, env, timeout):
            managed.append((command, env, timeout))
            if "install" in command:
                (workspace / "node_modules").mkdir(exist_ok=True)
                lifecycle.append("dependencies_ready")
                return install_result or {
                    "exit_code": 0, "output": "", "timed_out": False,
                    "interrupted": False, "tree_stopped": True,
                }
            lifecycle.append("test_process_started")
            if process_tree_failure:
                validation.ACTIVE_PROCESS = Mock(pid=456)
                raise validation.ProcessTreeError("simulated unverified process tree")
            result = test_result or {
                "exit_code": 0, "output": SCENARIO_OUTPUT, "timed_out": False,
                "interrupted": False, "tree_stopped": True,
            }
            if unexpected_workspace_output:
                (workspace / "unrelated-source-output.txt").write_text("preserve me", encoding="utf-8")
            lifecycle.append("test_process_stopped")
            return result

        def verify_engine():
            lifecycle.append("engine_verified")
            if engine_interrupt:
                validation.INTERRUPT_PENDING = True
            return docker_config

        def run_command(command, **kwargs):
            command_runs.append((command, kwargs.get("env")))
            if command[0] == "/tool/pnpm" and command[1:] == ["--version"]:
                return "12.5.1"
            if command[0] == "/tool/pnpm" and command[1:4] == ["config", "get", "store-dir"]:
                return kwargs["env"]["npm_config_store_dir"]
            if command[-1:] == ["--version"]:
                return "v24.12.0"
            raise AssertionError(f"unexpected command: {command}")

        verification = {"base": BASE, "head": HEAD}
        verify_count = {"count": 0}

        def verify_workspace(*_args):
            verify_count["count"] += 1
            if unexpected_workspace_output and verify_count["count"] >= 2:
                raise validation.ValidationError("simulated unexpected workspace drift")
            if revision_mismatch or (post_test_revision_drift and verify_count["count"] >= 2):
                return {"base": BASE, "head": "3" * 40}
            return verification

        output = io.StringIO()
        failure = None
        args = self._arguments(workspace, versions)
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(output))
            stack.enter_context(patch.object(validation, "trusted_versions_file", return_value=versions))
            stack.enter_context(patch.object(validation, "verify_trusted_runner_checkout",
                                              return_value={"root": root, "head": BASE}))
            stack.enter_context(patch.object(validation, "validate_workspace_package_setup",
                                              return_value=(Path("/tool/pnpm"), "12.5.1")))
            stack.enter_context(patch.object(validation, "resolve_tool_executable",
                                              side_effect=lambda name: Path(f"/tool/{name}")))
            stack.enter_context(patch.object(validation, "verify_workspace", side_effect=verify_workspace))
            stack.enter_context(patch.object(validation, "verify_engine", side_effect=verify_engine))
            stack.enter_context(patch.object(validation, "run", side_effect=run_command))
            stack.enter_context(patch.object(validation, "run_managed", side_effect=run_managed))
            stack.enter_context(patch.object(validation, "docker", side_effect=docker))
            stack.enter_context(patch.object(validation, "docker_inspect_optional", side_effect=inspect_owned))
            if process_tree_failure:
                stack.enter_context(patch.object(validation, "stop_process_tree", side_effect=validation.ProcessTreeError))
            try:
                validation.run_validation(args)
            except (validation.ValidationError, KeyboardInterrupt) as error:
                failure = error
        validation.ACTIVE_PROCESS = None
        validation.INTERRUPT_PENDING = False
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        return {
            "workspace": workspace, "versions": versions, "docker_config": docker_config,
            "lock": Path(tempfile.gettempdir()) / "jarvis-issue214-persistence-validation.lock",
            "failure": failure, "events": events, "calls": calls, "managed": managed,
            "command_runs": command_runs,
            "lifecycle": lifecycle, "raw_output": output.getvalue(), "identity": identity,
            "run_id": next((event["run_id"] for event in events if event.get("event") == "resources_requested"), None),
        }

    def test_workspace_verification_returns_exact_revision_identity(self):
        result = {"status": "verified", "source": {"base": BASE, "head": HEAD}}
        with patch.object(validation, "run", return_value=json.dumps(result)):
            self.assertEqual(validation.verify_workspace("/workspace", BASE, HEAD), {"base": BASE, "head": HEAD})
        with patch.object(validation, "run", return_value=json.dumps({
            "status": "verified", "source": {"base": BASE, "head": "3" * 40},
        })):
            with self.assertRaisesRegex(validation.ValidationError, "do not match expected"):
                validation.verify_workspace("/workspace", BASE, HEAD)

    def test_trusted_runner_checkout_requires_expected_head_and_clean_status(self):
        root = validation.trusted_repository_root().resolve()
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            pins = root / "infra/colima/versions.env"
            with patch.object(validation, "run", side_effect=[str(root), BASE, ""]) as git_run:
                result = validation.verify_trusted_runner_checkout(BASE, workspace, pins)
            self.assertEqual(result, {"root": root, "head": BASE})
            self.assertEqual(git_run.call_count, 3)
            for call in git_run.call_args_list:
                command = call.args[0]
                self.assertEqual(command[0], "git")
                self.assertIn("-C", command)
                self.assertEqual(call.kwargs["env"]["GIT_CONFIG_NOSYSTEM"], "1")
                self.assertEqual(call.kwargs["env"]["GIT_ALLOW_PROTOCOL"], "file")
                self.assertEqual(call.kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")

    def test_trusted_runner_wrong_head_and_dirty_checkout_fail_closed(self):
        root = validation.trusted_repository_root().resolve()
        pins = root / "infra/colima/versions.env"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            with patch.object(validation, "run", side_effect=[str(root), "3" * 40]):
                with self.assertRaisesRegex(validation.ValidationError, "HEAD does not equal"):
                    validation.verify_trusted_runner_checkout(BASE, workspace, pins)
            with patch.object(validation, "run", side_effect=[str(root), BASE, " M tracked-file"]):
                with self.assertRaisesRegex(validation.ValidationError, "tracked, index, or untracked drift"):
                    validation.verify_trusted_runner_checkout(BASE, workspace, pins)

    def test_trusted_runner_rejects_validation_workspace_nesting(self):
        root = validation.trusted_repository_root().resolve()
        pins = root / "infra/colima/versions.env"
        for workspace in (root, root / ".agents"):
            with self.subTest(workspace=workspace), patch.object(validation, "run") as git_run:
                with self.assertRaisesRegex(validation.ValidationError, "must be separate"):
                    validation.verify_trusted_runner_checkout(BASE, workspace, pins)
                git_run.assert_not_called()

    def test_workspace_shas_must_be_full_lowercase_ids(self):
        for invalid in ("1" * 39, "A" * 40, "2" * 65):
            with self.subTest(invalid=invalid):
                self.assertFalse(validation.SHA_PATTERN.fullmatch(invalid))
        self.assertTrue(validation.SHA_PATTERN.fullmatch("f" * 64))

    def test_frozen_install_preflight_pins_manager_and_rejects_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trusted, candidate = root / "trusted", root / "candidate"
            trusted.mkdir()
            candidate.mkdir()
            root_manifest = {"packageManager": "pnpm@12.5.1", "engines": {"node": ">=24 <25"}, "scripts": {}}
            lock_content = (
                "    packageManagerDependencies:\n      pnpm:\n        specifier: 12.5.1\n        version: 12.5.1\n"
            )
            workspace_content = "packages:\n  - apps/*\n  - packages/*\n\nallowBuilds:\n  esbuild: true\n"
            for base in (trusted, candidate):
                (base / "package.json").write_text(json.dumps(root_manifest), encoding="utf-8")
                (base / "pnpm-lock.yaml").write_text(lock_content, encoding="utf-8")
                (base / "pnpm-workspace.yaml").write_text(workspace_content, encoding="utf-8")
            for relative, scripts in validation.BUILD_SCRIPTS.items():
                for base in (trusted, candidate):
                    manifest_path = base / relative
                    manifest_path.parent.mkdir(parents=True, exist_ok=True)
                    manifest_path.write_text(json.dumps({"scripts": {name: f"trusted {name}" for name in scripts}}), encoding="utf-8")
            trusted_config = "engine-strict=true\nsave-exact=true\n"
            (trusted / ".npmrc").write_text(trusted_config, encoding="utf-8")
            (candidate / ".npmrc").write_text(trusted_config, encoding="utf-8")
            with patch.object(validation, "trusted_repository_root", return_value=trusted), \
                    patch.object(validation, "resolve_tool_executable", return_value=Path("/tool/pnpm")):
                executable, version = validation.validate_workspace_package_setup(candidate)
                self.assertEqual((executable, version), (Path("/tool/pnpm"), "12.5.1"))
                redirected_lock = lock_content + (
                    "\npackages:\n  injected@1.0.0:\n    resolution:\n"
                    "      tarball: https://attacker.invalid/injected.tgz\n"
                )
                (candidate / "pnpm-lock.yaml").write_text(redirected_lock, encoding="utf-8")
                with self.assertRaisesRegex(validation.ValidationError, "pnpm-lock.yaml must match the trusted base"):
                    validation.validate_workspace_package_setup(candidate)
                (candidate / "pnpm-lock.yaml").write_text(lock_content, encoding="utf-8")
                (candidate / "pnpm-workspace.yaml").write_text(workspace_content + "# changed workspace\n", encoding="utf-8")
                with self.assertRaisesRegex(validation.ValidationError, "pnpm-workspace.yaml must match the trusted base"):
                    validation.validate_workspace_package_setup(candidate)
                (candidate / "pnpm-workspace.yaml").write_text(workspace_content, encoding="utf-8")
                (candidate / ".npmrc").write_text("//registry.example/:_authToken=candidate-secret", encoding="utf-8")
                with self.assertRaisesRegex(validation.ValidationError, "differs from the trusted base"):
                    validation.validate_workspace_package_setup(candidate)
                (candidate / ".npmrc").write_text(trusted_config, encoding="utf-8")
                manifest = json.loads((candidate / "packages/persistence/package.json").read_text())
                manifest["scripts"]["test"] = "candidate altered script"
                (candidate / "packages/persistence/package.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(validation.ValidationError, "differs from trusted base"):
                    validation.validate_workspace_package_setup(candidate)

    def test_package_setup_rejects_candidate_npmrc(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trusted, candidate = root / "trusted", root / "candidate"
            trusted.mkdir()
            candidate.mkdir()
            package = {"packageManager": "pnpm@12.5.1", "engines": {"node": ">=24 <25"}, "scripts": {}}
            for base in (trusted, candidate):
                (base / "package.json").write_text(json.dumps(package))
                (base / "pnpm-lock.yaml").write_text(
                    "    packageManagerDependencies:\n      pnpm:\n        specifier: 12.5.1\n        version: 12.5.1\n",
                )
                (base / "pnpm-workspace.yaml").write_text("packages:\n  - apps/*\n  - packages/*\n")
            for relative, scripts in validation.BUILD_SCRIPTS.items():
                for base in (trusted, candidate):
                    path = base / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({"scripts": {name: name for name in scripts}}))
            with patch.object(validation, "trusted_repository_root", return_value=trusted), \
                    patch.object(validation, "resolve_tool_executable", return_value=Path("/tool/pnpm")):
                for config_name in (".npmrc", ".pnpmfile.cjs"):
                    with self.subTest(config=config_name):
                        config = candidate / config_name
                        config.write_text("candidate configuration or executable hook")
                        expected = "differs from the trusted base" if config_name == ".npmrc" else "npm configuration/hooks"
                        with self.assertRaisesRegex(validation.ValidationError, expected):
                            validation.validate_workspace_package_setup(candidate)
                        config.unlink()

    def test_actual_pnpm_config_resolves_store_inside_isolated_store_dir(self):
        pnpm = validation.resolve_tool_executable("pnpm")
        node = validation.resolve_tool_executable("node")
        with tempfile.TemporaryDirectory(prefix="jarvis-pnpm-store-test-") as directory:
            root = Path(directory)
            home, store = root / "home", root / "store"
            home.mkdir()
            store.mkdir()
            env = validation.package_manager_environment(home, store, node, pnpm)
            self.assertEqual(env["npm_config_store_dir"], str(store))
            self.assertEqual(env["PNPM_STORE_DIR"], str(store))
            resolved = validation.verify_package_manager_store(Path(pnpm), Path.cwd(), env, store)
            self.assertTrue(resolved.is_relative_to(store.resolve()))

    def test_test_summary_and_required_scenario_results_are_reportable(self):
        self.assertEqual(validation.parse_test_summary(SUMMARY), {"total": 4, "pass": 2, "fail": 0, "skip": 2})
        results = validation.required_scenario_results(SCENARIO_OUTPUT)
        self.assertEqual([item["result"] for item in results], ["passed", "passed"])
        first, second = validation.INTEGRATION_SCENARIOS
        self.assertEqual(validation.required_scenario_results(f"  ﹣ {first} (1ms)\n  ✖ {second} (1ms)")
                         , [{"name": first, "result": "skipped"}, {"name": second, "result": "failed"}])
        self.assertIsNone(validation.parse_test_summary("no summary"))

    def test_generated_outputs_remove_only_exact_allowed_paths_and_reject_escapes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            allowed = [workspace / "node_modules", workspace / "packages/persistence/dist"]
            package_root = workspace / "packages/persistence"
            package_root.mkdir(parents=True)
            (package_root / "package.json").write_text("{}", encoding="utf-8")
            for path in allowed:
                path.mkdir(parents=True)
                (path / "generated.txt").write_text("generated", encoding="utf-8")
            unrelated = workspace / "unrelated.txt"
            unrelated.write_text("preserve", encoding="utf-8")
            removed = validation.remove_expected_build_outputs(allowed, workspace)
            self.assertEqual(set(removed), {"node_modules", "dist"})
            self.assertTrue(all(not path.exists() for path in allowed))
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "preserve")
            with self.assertRaisesRegex(validation.ValidationError, "not an exact allowlisted"):
                validation.remove_expected_build_outputs([unrelated], workspace)
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "preserve")

            outside = root / "outside"
            outside.mkdir()
            protected = outside / "keep.txt"
            protected.write_text("outside workspace", encoding="utf-8")
            escaped_symlink = workspace / "node_modules"
            escaped_symlink.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(validation.ValidationError, "escaped"):
                validation.remove_expected_build_outputs([escaped_symlink], workspace)
            self.assertTrue(escaped_symlink.is_symlink())
            self.assertEqual(protected.read_text(encoding="utf-8"), "outside workspace")
            with self.assertRaisesRegex(validation.ValidationError, "escaped"):
                validation.remove_expected_build_outputs([outside], workspace)
            self.assertEqual(protected.read_text(encoding="utf-8"), "outside workspace")

    def test_nested_tap_scenarios_accept_indentation_and_reject_skip_failure_and_duplicates(self):
        first, second = validation.INTEGRATION_SCENARIOS
        passing_tap = f"""TAP version 13
    # Subtest: PostgreSQL persistence integration
        # Subtest: queue worker composition
            ok 8 - {first}
            ok 9 - {second}
        1..2
    1..1
1..1
"""
        self.assertEqual([item["result"] for item in validation.required_scenario_results(passing_tap)],
                         ["passed", "passed"])
        skipped_tap = f"""TAP version 13
    # Subtest: PostgreSQL persistence integration
        ok 8 - {first} # SKIP opt-in
        not ok 9 - {second}
        1..2
    1..1
1..1
"""
        self.assertEqual([item["result"] for item in validation.required_scenario_results(skipped_tap)],
                         ["skipped", "failed"])
        commented_or_duplicated = f"""    # ok 8 - {first}
    ok 8 - {first}
    ok 9 - {first}
    ok 10 - {second}
"""
        self.assertEqual([item["result"] for item in validation.required_scenario_results(commented_or_duplicated)],
                         ["missing_or_ambiguous", "passed"])

    def test_node_spec_reporter_requires_execution_and_rejects_skips(self):
        first, second = validation.INTEGRATION_SCENARIOS
        validation.assert_scenario_results(f"  ✔ {first} (12.3ms)\n  ✔ {second} (20.1ms)")
        for output in (
            f"  ﹣ {first} (0.1ms) # opt-in\n  ✔ {second} (20.1ms)",
            f"  ✔ {first} (0.1ms)\n  ✔ {first} (0.1ms)\n  ✔ {second} (20.1ms)",
            f"  ✔ {first} (0.1ms)",
        ):
            with self.subTest(output=output), self.assertRaisesRegex(validation.ValidationError, "did not execute"):
                validation.assert_scenario_results(output)

    def test_pinned_postgres_image_and_platform_are_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            pins = Path(directory) / "versions.env"
            pins.write_text(f"POSTGRES_IMAGE={IMAGE}\nPOSTGRES_PLATFORM=linux/arm64\n", encoding="utf-8")
            self.assertEqual(validation.read_pins(pins), (IMAGE, "linux/arm64"))
            pins.write_text(f"POSTGRES_IMAGE={IMAGE}\nPOSTGRES_PLATFORM=linux/amd64\n", encoding="utf-8")
            with self.assertRaisesRegex(validation.ValidationError, "not linux/arm64"):
                validation.read_pins(pins)

    def test_clean_workspace_installs_frozen_dependencies_before_resources_and_reports_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory))
        self.assertIsNone(result["failure"])
        self.assertEqual(len(result["managed"]), 2)
        install_command, install_env, install_timeout = result["managed"][0]
        test_command, test_env, test_timeout = result["managed"][1]
        store_arg = install_env["npm_config_store_dir"]
        self.assertEqual(install_command[1:4], ["--store-dir", store_arg, "install"])
        self.assertEqual(install_command[4:], ["--frozen-lockfile", "--ignore-scripts"])
        self.assertEqual(test_command[1:3], ["--store-dir", store_arg])
        self.assertEqual(test_command[3:], validation.PACKAGE_COMMAND[1:])
        self.assertLess(result["lifecycle"].index("dependencies_ready"), result["lifecycle"].index("engine_verified"))
        self.assertLess(result["lifecycle"].index("engine_verified"), result["lifecycle"].index("volume_create"))
        self.assertNotIn("GITHUB_TOKEN", test_env)
        self.assertNotIn("JARVIS_TEST_DATABASE_URL", install_env)
        self.assertEqual(install_timeout, validation.SETUP_TIMEOUT)
        self.assertEqual(test_timeout, validation.TEST_TIMEOUT)
        self.assertTrue(install_env["HOME"].startswith(str(Path(tempfile.gettempdir()))))
        self.assertEqual(install_env["npm_config_store_dir"], install_env["PNPM_STORE_DIR"])
        self.assertEqual(result["command_runs"][2][0][1:4], ["config", "get", "store-dir"])
        self.assertEqual(result["command_runs"][2][0][4:], ["--store-dir", store_arg])
        self.assertEqual(result["command_runs"][2][1]["npm_config_store_dir"], install_env["npm_config_store_dir"])
        store_event = next(item for item in result["events"] if item.get("event") == "package_store_verified")
        self.assertEqual(store_event["store"], str(Path(install_env["npm_config_store_dir"]).resolve()))
        self.assertEqual(test_env["NPM_CONFIG_USERCONFIG"], os.devnull)
        self.assertEqual(test_env["NPM_CONFIG_GLOBALCONFIG"], os.devnull)
        self.assertFalse((result["workspace"] / "node_modules").exists())
        event = next(item for item in result["events"] if item.get("event") == "test_result")
        self.assertEqual(event["provenance"], "reviewer-executed")
        self.assertEqual(event["exit_code"], 0)
        self.assertEqual(event["summary"], {"total": 4, "pass": 2, "fail": 0, "skip": 2})
        self.assertEqual([item["result"] for item in event["required_scenarios"]], ["passed", "passed"])
        self.assertEqual(event["base"], BASE)
        self.assertEqual(event["head"], HEAD)
        resources = next(item for item in result["events"] if item.get("event") == "resources_requested")
        self.assertEqual(resources["image"], IMAGE)
        self.assertIn("@sha256:", resources["image"])
        self.assertFalse(result["docker_config"].exists())
        self.assertFalse(result["lock"].exists())
        self.assertNotIn("POSTGRES_PASSWORD", result["raw_output"])

    def test_revision_mismatch_fails_before_dependency_or_resource_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            versions = root / "versions.env"
            versions.write_text(f"POSTGRES_IMAGE={IMAGE}\nPOSTGRES_PLATFORM=linux/arm64\n")
            output = io.StringIO()
            with patch.object(validation, "trusted_versions_file", return_value=versions), \
                    patch.object(validation, "verify_trusted_runner_checkout", return_value={"root": root, "head": BASE}), \
                    patch.object(validation, "verify_workspace", return_value={"base": BASE, "head": "3" * 40}), \
                    patch.object(validation, "expected_build_outputs", return_value=[]), \
                    patch.object(validation, "validate_workspace_package_setup") as package_setup, \
                    patch.object(validation, "verify_engine") as engine, \
                    patch.object(validation, "docker") as docker, redirect_stdout(output):
                with self.assertRaisesRegex(validation.ValidationError, "do not match expected"):
                    validation.run_validation(self._arguments(workspace, versions))
            package_setup.assert_not_called()
            engine.assert_not_called()
            docker.assert_not_called()
            result = json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(result["status"], "failed")

    def test_existing_shared_lock_is_preserved_and_blocks_setup_before_provisioning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            versions = root / "versions.env"
            versions.write_text(f"POSTGRES_IMAGE={IMAGE}\nPOSTGRES_PLATFORM=linux/arm64\n", encoding="utf-8")
            lock_parent = root / "tmp"
            lock_parent.mkdir()
            lock = lock_parent / "jarvis-issue214-persistence-validation.lock"
            lock.mkdir()
            owner_file = lock / "owner"
            owner_file.write_text("another-owner-run", encoding="ascii")
            before = (lock.stat().st_ino, owner_file.read_bytes())
            output = io.StringIO()
            with ExitStack() as stack:
                stack.enter_context(redirect_stdout(output))
                stack.enter_context(patch.object(validation, "tempfile"))
                validation.tempfile.gettempdir.return_value = str(lock_parent)
                stack.enter_context(patch.object(validation, "trusted_versions_file", return_value=versions))
                stack.enter_context(patch.object(validation, "verify_trusted_runner_checkout",
                                                  return_value={"root": root, "head": BASE}))
                stack.enter_context(patch.object(validation, "verify_workspace", return_value={"base": BASE, "head": HEAD}))
                stack.enter_context(patch.object(validation, "expected_build_outputs", return_value=[]))
                setup = stack.enter_context(patch.object(validation, "validate_workspace_package_setup",
                                                          return_value=(Path("/tool/pnpm"), "12.5.1")))
                stack.enter_context(patch.object(validation, "verify_engine"))
                docker = stack.enter_context(patch.object(validation, "docker"))
                managed = stack.enter_context(patch.object(validation, "run_managed"))
                with self.assertRaisesRegex(validation.ValidationError, "another validation run may be active"):
                    validation.run_validation(self._arguments(workspace, versions))
            self.assertEqual((lock.stat().st_ino, owner_file.read_bytes()), before)
            setup.assert_called_once()
            managed.assert_not_called()
            docker.assert_not_called()
            self.assertFalse(any(json.loads(line).get("event") == "resources_requested"
                                 for line in output.getvalue().splitlines()))

    def test_install_failure_stops_before_engine_or_resource_provisioning(self):
        install_failure = {
            "exit_code": 17, "output": "", "timed_out": False,
            "interrupted": False, "tree_stopped": True,
        }
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), install_result=install_failure)
        self.assertIsInstance(result["failure"], validation.ValidationError)
        self.assertEqual(len(result["managed"]), 1)
        self.assertNotIn("engine_verified", result["lifecycle"])
        self.assertFalse(any(call[0] == "volume" for call in result["calls"]))
        self.assertFalse(result["lock"].exists())

    def test_post_test_revision_drift_invalidates_success(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), post_test_revision_drift=True)
        self.assertIsInstance(result["failure"], validation.ValidationError)
        self.assertIn("changed during the test run", str(result["failure"]))
        self.assertTrue(any(event.get("event") == "test_result" for event in result["events"]))

    def test_unexpected_workspace_drift_fails_incomplete_but_cleans_owned_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), unexpected_workspace_output=True)
            self.assertIsInstance(result["failure"], validation.ValidationError)
            self.assertTrue(any(event.get("status") == "cleanup_incomplete" for event in result["events"]))
            self.assertTrue(any(event.get("event") == "test_result" for event in result["events"]))
            self.assertIn(["rm", "--force", "b" * 64], result["calls"])
            self.assertIn(["volume", "rm", result["identity"]["volume"]], result["calls"])
            unrelated = result["workspace"] / "unrelated-source-output.txt"
            self.assertEqual(unrelated.read_text(encoding="utf-8"), "preserve me")
            self.assertFalse((result["workspace"] / "node_modules").exists())

    def test_engine_config_interruption_is_cleaned_without_resource_provisioning(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), engine_interrupt=True)
        self.assertIsInstance(result["failure"], KeyboardInterrupt)
        self.assertFalse(result["docker_config"].exists())
        self.assertFalse(result["lock"].exists())
        self.assertFalse(result["calls"])
        self.assertTrue(any(event.get("status") == "interrupted" for event in result["events"]))

    def test_timeout_and_nonzero_test_exit_report_counts_and_clean_after_stopped_tree(self):
        outcome = {
            "exit_code": -15, "output": SCENARIO_OUTPUT, "timed_out": True,
            "interrupted": False, "tree_stopped": True,
        }
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), test_result=outcome)
        self.assertIsInstance(result["failure"], validation.ValidationError)
        report = next(event for event in result["events"] if event.get("event") == "test_result")
        self.assertEqual(report["exit_code"], -15)
        self.assertEqual(report["summary"], {"total": 4, "pass": 2, "fail": 0, "skip": 2})
        self.assertTrue(report["process_tree_stopped"])
        self.assertLess(result["lifecycle"].index("test_process_stopped"), result["lifecycle"].index("container_cleanup"))
        self.assertIn(["rm", "--force", "b" * 64], result["calls"])
        self.assertIn(["volume", "rm", result["identity"]["volume"]], result["calls"])

    def test_interrupted_test_process_reports_exit_then_cleans_resources(self):
        outcome = {
            "exit_code": -15, "output": SCENARIO_OUTPUT, "timed_out": False,
            "interrupted": True, "tree_stopped": True,
        }
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), test_result=outcome)
        report = next(event for event in result["events"] if event.get("event") == "test_result")
        self.assertEqual(report["exit_code"], -15)
        self.assertEqual(report["summary"]["total"], 4)
        self.assertTrue(report["interrupted"])
        self.assertIn(["rm", "--force", "b" * 64], result["calls"])

    def test_interrupt_during_cleanup_is_recorded_after_cleanup_finishes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), interrupt_during_cleanup=True)
        self.assertIsInstance(result["failure"], KeyboardInterrupt)
        self.assertIn("container_cleanup", result["lifecycle"])
        self.assertIn("volume_cleanup", result["lifecycle"])
        self.assertTrue(any(event.get("event") == "cleanup_incomplete" for event in result["events"]))

    def test_process_tree_uncertainty_retains_lock_and_skips_docker_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), process_tree_failure=True)
            self.assertIsInstance(result["failure"], validation.ProcessTreeError)
            self.assertTrue(result["lock"].exists())
            self.assertNotIn("container_cleanup", result["lifecycle"])
            self.assertNotIn("volume_cleanup", result["lifecycle"])
            owner = (result["lock"] / "owner").read_text(encoding="ascii")
            self.assertEqual(owner, result["run_id"])
            shutil.rmtree(result["lock"])

    def test_resource_identity_drift_leaves_container_and_volume_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._run_mocked_runner(Path(directory), identity_drift=True)
        self.assertIsInstance(result["failure"], validation.ValidationError)
        self.assertNotIn("container_cleanup", result["lifecycle"])
        self.assertNotIn("volume_cleanup", result["lifecycle"])
        self.assertTrue(any(event.get("event") == "cleanup_incomplete" for event in result["events"]))

    def test_stop_process_tree_escalates_and_verifies_group_exit(self):
        process = Mock(pid=321, returncode=0)
        process.wait.return_value = 0
        process.poll.return_value = 0
        validation.ACTIVE_PROCESS = process
        with patch.object(validation, "process_group_exists", side_effect=[True, False, False, False]), \
                patch.object(validation.os, "killpg") as killpg:
            validation.stop_process_tree(process)
        killpg.assert_called_once_with(321, validation.signal.SIGTERM)
        self.assertIsNone(validation.ACTIVE_PROCESS)

    def test_stop_process_tree_fails_closed_when_group_remains(self):
        process = Mock(pid=654, returncode=0)
        process.wait.return_value = 0
        process.poll.return_value = 0
        validation.ACTIVE_PROCESS = process
        with patch.object(validation, "process_group_exists", return_value=True), \
                patch.object(validation.time, "monotonic", side_effect=[0, 1, 9, 10, 20]), \
                patch.object(validation.time, "sleep"), patch.object(validation.os, "killpg") as killpg:
            with self.assertRaisesRegex(validation.ProcessTreeError, "could not establish"):
                validation.stop_process_tree(process)
        self.assertEqual([call.args[1] for call in killpg.call_args_list],
                         [validation.signal.SIGTERM, validation.signal.SIGKILL])
        self.assertIs(validation.ACTIVE_PROCESS, process)
        validation.ACTIVE_PROCESS = None

    def test_managed_command_reports_timeout_and_interruption_after_stopping_tree(self):
        class FakeProcess:
            def __init__(self, behavior, *, stdout, **_kwargs):
                self.behavior = behavior
                self.returncode = -15 if behavior == "timeout" else 130
                self.pid = 765
                stdout.write(SCENARIO_OUTPUT)

            def wait(self, timeout=None):
                if self.behavior == "timeout":
                    raise validation.subprocess.TimeoutExpired("pnpm", timeout)
                if self.behavior == "interrupt":
                    raise KeyboardInterrupt
                return self.returncode

            def poll(self):
                return self.returncode

        for behavior in ("timeout", "interrupt"):
            with self.subTest(behavior=behavior):
                validation.ACTIVE_PROCESS = None
                with patch.object(validation.subprocess, "Popen", side_effect=lambda *a, **kw: FakeProcess(behavior, **kw)), \
                        patch.object(validation, "stop_process_tree", side_effect=lambda process: setattr(validation, "ACTIVE_PROCESS", None)) as stop:
                    outcome = validation.run_managed(["pnpm", "test"], cwd=".", env={}, timeout=1)
                self.assertTrue(outcome["tree_stopped"])
                self.assertEqual(outcome["timed_out"], behavior == "timeout")
                self.assertEqual(outcome["interrupted"], behavior == "interrupt")
                self.assertIn("ℹ tests 4", outcome["output"])
                stop.assert_called_once()

    def test_cleanup_identity_mismatch_is_never_removed(self):
        container = {
            "Id": "a" * 64, "Name": "/owned-name",
            "Config": {"Image": IMAGE, "Labels": {"org.jarvis.issue214.run": "wrong-run"}},
        }
        volume = {"Name": "owned-volume", "Labels": {"org.jarvis.issue214.run": "wrong-run"}}
        with patch.object(validation, "docker_inspect_optional", side_effect=[container, volume]), \
                patch.object(validation, "docker") as docker:
            errors = validation.cleanup_docker_resources(
                "a" * 64, True, name="owned-name", volume="owned-volume",
                label="org.jarvis.issue214.run", run_id="expected-run", image=IMAGE,
            )
        self.assertEqual(len(errors), 2)
        docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
