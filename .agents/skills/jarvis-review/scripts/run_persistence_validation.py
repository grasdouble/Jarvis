#!/usr/bin/env python3
"""Run the persistence integration suite against an isolated pinned PostgreSQL container."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


CONTEXT = "colima-jarvis"
PLATFORM = "linux/arm64"
PACKAGE_COMMAND = ["pnpm", "--filter", "@jarvis/persistence", "test"]
INTEGRATION_SCENARIOS = (
    "real PostgreSQL stop controls gate and cancel the real queue worker composition",
    "persisted stop state survives an operating-system worker restart",
)
COMMAND_TIMEOUT = 30
TEST_TIMEOUT = 20 * 60
SETUP_TIMEOUT = 10 * 60
SHA_PATTERN = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_DATABASE_NAME = re.compile(r"^jarvis_issue8_[a-f0-9]{32}$")
DOCKER_ENV = None
ACTIVE_PROCESS = None
INTERRUPTS_DEFERRED = False
INTERRUPT_PENDING = False
BUILD_SCRIPTS = {
    "apps/api/package.json": ("build",),
    "apps/worker/package.json": ("build",),
    "packages/domain/package.json": ("build",),
    "packages/queue/package.json": ("build",),
    "packages/persistence/package.json": ("build", "test"),
}
FORBIDDEN_LIFECYCLE_HOOKS = {
    "preinstall", "install", "postinstall", "prepare", "prebuild", "postbuild",
    "pretest", "posttest", "prestart", "poststart",
}


class ValidationError(Exception):
    pass


class ProcessTreeError(ValidationError):
    pass


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, sort_keys=True), flush=True)


def run(args, *, timeout=COMMAND_TIMEOUT, env=None, input_text=None, cwd=None):
    command_env = env if env is not None else {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", str(Path.home())),
        "TMPDIR": os.environ.get("TMPDIR", tempfile.gettempdir()),
        "LC_ALL": "C",
        **{name: os.environ[name] for name in (
            "ASDF_DATA_DIR", "ASDF_NODEJS_VERSION", "ASDF_PNPM_VERSION",
        ) if name in os.environ},
    }
    try:
        result = subprocess.run(
            args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, env=command_env, input=input_text, check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValidationError(f"command timed out: {args[0]}") from error
    except OSError as error:
        raise ValidationError(f"command unavailable: {args[0]}") from error
    if result.returncode:
        # Never echo subprocess output: Docker errors may include expanded configuration.
        raise ValidationError(f"command failed: {args[0]} (exit {result.returncode})")
    return result.stdout.strip()


def interrupt_handler(_signum, _frame):
    global INTERRUPT_PENDING
    if INTERRUPTS_DEFERRED:
        INTERRUPT_PENDING = True
    else:
        raise KeyboardInterrupt


@contextmanager
def defer_interrupts(*, raise_pending=True):
    """Defer SIGINT/SIGTERM across resource acquisition/release bookkeeping."""
    global INTERRUPTS_DEFERRED, INTERRUPT_PENDING
    was_deferred = INTERRUPTS_DEFERRED
    INTERRUPTS_DEFERRED = True
    try:
        yield
    finally:
        INTERRUPTS_DEFERRED = was_deferred
        if not was_deferred and INTERRUPT_PENDING and raise_pending:
            INTERRUPT_PENDING = False
            raise KeyboardInterrupt


def trusted_repository_root():
    return Path(__file__).resolve().parents[4]


def trusted_git_environment():
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": tempfile.gettempdir(),
        "TMPDIR": tempfile.gettempdir(),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_OPTIONAL_LOCKS": "0",
        "LC_ALL": "C",
    }


def verify_trusted_runner_checkout(expected_base, workspace, versions):
    """Prove this runner and its local pins/helper come from the exact clean base checkout."""
    try:
        root = trusted_repository_root().resolve(strict=True)
        workspace_root = Path(workspace).resolve(strict=True)
        versions_path = Path(versions).resolve(strict=True)
        runner_path = Path(__file__).resolve(strict=True)
        helper_path = runner_path.with_name("prepare_validation_workspace.py").resolve(strict=True)
        expected_runner = (root / ".agents/skills/jarvis-review/scripts/run_persistence_validation.py").resolve(strict=True)
        expected_helper = (root / ".agents/skills/jarvis-review/scripts/prepare_validation_workspace.py").resolve(strict=True)
        expected_pins = (root / "infra/colima/versions.env").resolve(strict=True)
    except OSError as error:
        raise ValidationError("trusted runner checkout or required trusted files are unavailable") from error

    if runner_path != expected_runner or helper_path != expected_helper or versions_path != expected_pins:
        raise ValidationError("runner, workspace helper, and PostgreSQL pins must derive from the trusted checkout")
    if (workspace_root == root or workspace_root.is_relative_to(root)
            or root.is_relative_to(workspace_root)):
        raise ValidationError("validation workspace must be separate from and not nested with the trusted checkout")

    git_env = trusted_git_environment()
    git_prefix = [
        "git", "-c", f"core.hooksPath={os.devnull}", "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false", "-C", str(root),
    ]
    top = run([*git_prefix, "rev-parse", "--show-toplevel"], cwd=root, env=git_env)
    if Path(top).resolve(strict=True) != root:
        raise ValidationError("trusted runner path is not the trusted Git checkout root")
    head = run([*git_prefix, "rev-parse", "--verify", "HEAD^{commit}"], cwd=root, env=git_env)
    if head != expected_base:
        raise ValidationError("trusted runner checkout HEAD does not equal --expected-base")
    drift = run([
        *git_prefix, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all",
    ], cwd=root, env=git_env)
    if drift:
        raise ValidationError("trusted runner checkout has tracked, index, or untracked drift")
    return {"root": root, "head": head}


def read_json(path, description):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"{description} is missing or invalid") from error
    if not isinstance(value, dict):
        raise ValidationError(f"{description} is not a JSON object")
    return value


def resolve_tool_executable(name):
    shim = shutil.which(name)
    if not shim:
        raise ValidationError(f"{name} executable is unavailable")
    asdf = shutil.which("asdf")
    if asdf:
        try:
            resolved = run([asdf, "which", name])
            path = Path(resolved).resolve(strict=True)
            if path.is_file():
                return path
        except (ValidationError, OSError):
            pass
    return Path(shim).resolve(strict=True)


def validate_workspace_package_setup(workspace):
    """Allow only trusted build/test scripts and scripts-disabled frozen installation."""
    trusted_root = trusted_repository_root()
    trusted_root_package = read_json(trusted_root / "package.json", "trusted package manifest")
    package_manager = trusted_root_package.get("packageManager")
    if not isinstance(package_manager, str) or not re.fullmatch(r"pnpm@[0-9]+\.[0-9]+\.[0-9]+", package_manager):
        raise ValidationError("trusted root packageManager pin is missing or unsupported")
    candidate_root = read_json(workspace / "package.json", "candidate root package manifest")
    if candidate_root.get("packageManager") != package_manager:
        raise ValidationError("candidate packageManager does not match the trusted base pin")
    if candidate_root.get("engines") != trusted_root_package.get("engines"):
        raise ValidationError("candidate Node.js engine requirement differs from trusted base")
    version = package_manager.removeprefix("pnpm@")
    for relative in ("pnpm-lock.yaml", "pnpm-workspace.yaml"):
        trusted_file = trusted_root / relative
        candidate_file = workspace / relative
        if (trusted_file.is_symlink() or candidate_file.is_symlink()
                or not trusted_file.is_file() or not candidate_file.is_file()
                or trusted_file.read_bytes() != candidate_file.read_bytes()):
            raise ValidationError(
                f"candidate {relative} must match the trusted base; dependency/workspace changes require a separately reviewed setup path"
            )
    lock = (workspace / "pnpm-lock.yaml").read_text(encoding="utf-8")
    importer_pin = re.search(
        r"(?ms)^    packageManagerDependencies:\n      pnpm:\n        specifier: ([^\n]+)\n        version: ([^\n]+)", lock,
    )
    if not importer_pin or importer_pin.groups() != (version, version):
        raise ValidationError("frozen lockfile package-manager version does not match packageManager")

    for relative, scripts in BUILD_SCRIPTS.items():
        trusted = read_json(trusted_root / relative, f"trusted {relative}")
        candidate = read_json(workspace / relative, f"candidate {relative}")
        trusted_scripts = trusted.get("scripts", {})
        candidate_scripts = candidate.get("scripts", {})
        for script in scripts:
            if candidate_scripts.get(script) != trusted_scripts.get(script):
                raise ValidationError(f"candidate {relative} {script} script differs from trusted base")

    manifest_paths = [workspace / "package.json", *workspace.glob("apps/*/package.json"),
                      *workspace.glob("packages/*/package.json")]
    candidate_npmrc = workspace / ".npmrc"
    trusted_npmrc = trusted_root / ".npmrc"
    if candidate_npmrc.exists() or candidate_npmrc.is_symlink():
        if (candidate_npmrc.is_symlink() or not candidate_npmrc.is_file()
                or trusted_npmrc.is_symlink() or not trusted_npmrc.is_file()
                or candidate_npmrc.read_bytes() != trusted_npmrc.read_bytes()):
            raise ValidationError("candidate npm configuration differs from the trusted base")
    config_paths = [workspace / ".pnpmfile.cjs", workspace / ".pnpmfile.js",
                    workspace / ".pnpmfile.mjs", *workspace.glob("apps/*/.npmrc"),
                    *workspace.glob("packages/*/.npmrc")]
    if any(path.exists() or path.is_symlink() for path in config_paths):
        raise ValidationError("candidate npm configuration/hooks are unsupported for credential-free validation")
    for manifest_path in manifest_paths:
        manifest = read_json(manifest_path, "workspace package manifest")
        scripts = manifest.get("scripts", {})
        if not isinstance(scripts, dict):
            raise ValidationError("workspace package scripts must be an object")
        hooks = FORBIDDEN_LIFECYCLE_HOOKS.intersection(scripts)
        if hooks:
            raise ValidationError("candidate lifecycle hooks are not permitted during validation")

    return resolve_tool_executable("pnpm"), version


def package_manager_environment(home, store, node_executable, pnpm_executable):
    tool_paths = [str(Path(node_executable).parent), str(Path(pnpm_executable).parent)]
    tool_paths.extend(os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep))
    path = os.pathsep.join(dict.fromkeys(tool_paths))
    return {
        "PATH": path,
        "HOME": str(home),
        "TMPDIR": os.environ.get("TMPDIR", tempfile.gettempdir()),
        "COREPACK_HOME": str(home / "corepack"),
        "PNPM_STORE_DIR": str(store),
        "npm_config_store_dir": str(store),
        "NPM_CONFIG_USERCONFIG": os.devnull,
        "NPM_CONFIG_GLOBALCONFIG": os.devnull,
        "LC_ALL": "C",
    }


def verify_package_manager_store(pnpm_executable, workspace, env, store):
    configured = run([
        str(pnpm_executable), "config", "get", "store-dir", "--store-dir", str(store),
    ], cwd=workspace, env=env)
    try:
        resolved = Path(configured).expanduser().resolve(strict=False)
        store_root = Path(store).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValidationError("pnpm store path could not be resolved safely") from error
    if not resolved.is_relative_to(store_root):
        raise ValidationError("pnpm store-dir does not resolve inside this run's isolated store")
    return resolved


def read_pins(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("\"'")
    image = values.get("POSTGRES_IMAGE", "")
    platform = values.get("POSTGRES_PLATFORM", "")
    if not re.fullmatch(r"postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", image):
        raise ValidationError("trusted PostgreSQL image pin is missing or invalid")
    if platform != PLATFORM:
        raise ValidationError("trusted PostgreSQL platform pin is not linux/arm64")
    return image, platform


def verify_workspace(workspace, expected_base, expected_head):
    helper = Path(__file__).with_name("prepare_validation_workspace.py")
    output = run([sys.executable, str(helper), "verify", "--workspace", str(workspace)])
    try:
        result = json.loads(output)
    except json.JSONDecodeError as error:
        raise ValidationError("workspace verifier returned invalid JSON") from error
    source = result.get("source", {}) if isinstance(result, dict) else {}
    if (not isinstance(result, dict) or result.get("status") != "verified" or source.get("base") != expected_base
            or source.get("head") != expected_head):
        raise ValidationError("validation workspace revisions do not match expected base/head")
    return {"base": source["base"], "head": source["head"]}


def trusted_versions_file():
    trusted_root = trusted_repository_root()
    return trusted_root / "infra" / "colima" / "versions.env"


def expected_build_outputs(workspace):
    package_roots = [workspace]
    for parent in (workspace / "apps", workspace / "packages"):
        if parent.is_dir():
            package_roots.extend(path.parent for path in parent.glob("*/package.json"))
    paths = {root / "node_modules" for root in package_roots}
    paths.update(workspace / relative for relative in (
        "apps/api/dist", "apps/worker/dist", "packages/domain/dist",
        "packages/queue/dist", "packages/persistence/dist",
    ))
    return sorted(paths)


def remove_expected_build_outputs(paths, workspace):
    workspace = workspace.resolve(strict=True)
    allowed_paths = {Path(os.path.abspath(path)) for path in expected_build_outputs(workspace)}
    removed = []
    for path in paths:
        resolved = path.resolve(strict=False)
        if resolved == workspace or not resolved.is_relative_to(workspace):
            raise ValidationError("generated output escaped the validation workspace; refusing cleanup")
        normalized_path = path.parent.resolve(strict=False) / path.name
        if normalized_path not in allowed_paths:
            raise ValidationError("generated output is not an exact allowlisted build/dependency path")
        if not path.exists() and not path.is_symlink():
            continue
        if path.is_symlink() or not path.is_dir():
            raise ValidationError("generated output path changed type; refusing cleanup")
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def process_group_exists(process):
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as error:
        raise ProcessTreeError("cannot verify the validation process group") from error


def stop_process_tree(process, grace_seconds=8):
    """Terminate and reap the process group; never report stopped on an uncertain result."""
    global ACTIVE_PROCESS
    try:
        if process_group_exists(process):
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            pass
        deadline = time.monotonic() + grace_seconds
        while process_group_exists(process) and time.monotonic() < deadline:
            time.sleep(0.05)
        if process_group_exists(process):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                pass
            deadline = time.monotonic() + grace_seconds
            while process_group_exists(process) and time.monotonic() < deadline:
                time.sleep(0.05)
        if process_group_exists(process) or process.poll() is None:
            raise ProcessTreeError("could not establish that the validation process tree stopped")
        if ACTIVE_PROCESS is process:
            ACTIVE_PROCESS = None
    except ProcessTreeError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        raise ProcessTreeError("could not establish that the validation process tree stopped") from error


def run_managed(command, *, cwd, env, timeout, output_limit=32 * 1024 * 1024):
    """Run one bounded command, stop its complete process group, then return redaction-safe data."""
    global ACTIVE_PROCESS
    output_file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    process = None
    interrupted = False
    timed_out = False
    tree_stopped = False
    try:
        try:
            with defer_interrupts():
                process = subprocess.Popen(
                    command, cwd=cwd, env=env, stdout=output_file, stderr=subprocess.STDOUT,
                    text=True, start_new_session=True,
                )
                ACTIVE_PROCESS = process
        except KeyboardInterrupt:
            interrupted = True
        if process is not None:
            if not interrupted:
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                except KeyboardInterrupt:
                    interrupted = True
            stop_process_tree(process)
            tree_stopped = True
        output_file.seek(0, os.SEEK_END)
        if output_file.tell() > output_limit:
            raise ValidationError("command output exceeded the safety limit")
        output_file.seek(0)
        output = output_file.read()
        return {
            "exit_code": process.returncode if process is not None else None,
            "output": output,
            "timed_out": timed_out,
            "interrupted": interrupted,
            "tree_stopped": tree_stopped,
        }
    finally:
        if process is not None and not tree_stopped:
            stop_process_tree(process)
        output_file.close()


def parse_test_summary(output):
    summary = {}
    labels = {"tests": "total", "pass": "pass", "fail": "fail", "skipped": "skip"}
    for line in output.splitlines():
        match = re.match(r"^\s*(?:ℹ|#)\s*(tests|pass|fail|skipped)\s+(\d+)\s*$", line)
        if match:
            summary[labels[match.group(1)]] = int(match.group(2))
    if set(summary) != {"total", "pass", "fail", "skip"}:
        return None
    return summary


def required_scenario_results(output):
    lines = output.splitlines()
    results = []
    for scenario in INTEGRATION_SCENARIOS:
        escaped = re.escape(scenario)
        tap = [line for line in lines if re.match(
            r"^[ \t]*(?:ok|not ok)\s+\d+\s+-\s+" + escaped + r"(?:\s|$)", line,
        )]
        spec = [line for line in lines if re.match(r"^\s*[✔﹣✖]\s+" + escaped + r"(?:\s|$)", line)]
        observed = tap + spec
        if len(observed) != 1:
            state = "missing_or_ambiguous"
        elif "# SKIP" in observed[0] or re.match(r"^\s*﹣", observed[0]):
            state = "skipped"
        elif re.match(r"^\s*not ok\s", observed[0]) or re.match(r"^\s*✖", observed[0]):
            state = "failed"
        else:
            state = "passed"
        results.append({"name": scenario, "result": state})
    return results


def cleanup_docker_resources(container_id, volume_requested, *, name, volume, label, run_id, image):
    errors = []
    if container_id:
        try:
            inspected = docker_inspect_optional("container", container_id)
            if inspected is not None:
                id_matches = (inspected.get("Id", "").startswith(container_id)
                              if re.fullmatch(r"[0-9a-f]{12,64}", container_id)
                              else inspected.get("Name", "").lstrip("/") == name)
                if (id_matches
                        and inspected.get("Config", {}).get("Labels", {}).get(label) == run_id
                        and inspected.get("Config", {}).get("Image") == image):
                    docker(["rm", "--force", container_id])
                    if docker_inspect_optional("container", container_id) is not None:
                        errors.append("container remained after removal")
                else:
                    errors.append("container identity changed; left untouched")
        except ValidationError:
            errors.append("container cleanup could not be verified")
    if volume_requested:
        try:
            inspected = docker_inspect_optional("volume", volume)
            if inspected is not None:
                if inspected.get("Name") == volume and inspected.get("Labels", {}).get(label) == run_id:
                    docker(["volume", "rm", volume])
                    if docker_inspect_optional("volume", volume) is not None:
                        errors.append("volume remained after removal")
                else:
                    errors.append("volume identity changed; left untouched")
        except ValidationError:
            errors.append("volume cleanup could not be verified")
    return errors


def docker(args, **kwargs):
    return run(["docker", "--context", CONTEXT, *args], env=DOCKER_ENV, **kwargs)


def docker_inspect_optional(resource_type, identifier):
    command = ["docker", "--context", CONTEXT, resource_type, "inspect", identifier]
    env = DOCKER_ENV or {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", str(Path.home())),
        "TMPDIR": os.environ.get("TMPDIR", tempfile.gettempdir()),
        "LC_ALL": "C",
    }
    try:
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=COMMAND_TIMEOUT, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValidationError("resource identity could not be inspected safely") from error
    if result.returncode:
        diagnostic = result.stderr.lower()
        if any(message in diagnostic for message in ("no such object", "no such container", "no such volume")):
            return None
        raise ValidationError("resource identity could not be inspected safely")
    try:
        values = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValidationError("resource inspection returned invalid data") from error
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ValidationError("resource inspection was ambiguous")
    return values[0]


def verify_engine():
    contexts = json.loads(run(["docker", "context", "inspect", CONTEXT]))
    if not isinstance(contexts, list) or len(contexts) != 1:
        raise ValidationError("Docker context identity is ambiguous")
    context = contexts[0]
    endpoint = context.get("Endpoints", {}).get("docker", {}).get("Host", "")
    storage = context.get("Storage", {})
    metadata_path = storage.get("MetadataPath")
    tls_path = storage.get("TLSPath")
    if (context.get("Name") != CONTEXT or not endpoint.startswith("unix://")
            or not re.search(r"colima[/\\]jarvis(?:[/\\]|$)", endpoint)
            or not isinstance(metadata_path, str) or not metadata_path):
        raise ValidationError("Docker context does not identify the dedicated Colima jarvis profile")
    if tls_path:
        tls_directory = Path(tls_path)
        if tls_directory.exists() and any(tls_directory.iterdir()):
            raise ValidationError("dedicated local Docker context unexpectedly uses TLS credential material")

    config_dir = Path(tempfile.mkdtemp(prefix="jarvis-docker-config-"))
    try:
        metadata_storage = Path(metadata_path).resolve(strict=True)
        metadata_file = metadata_storage / "meta.json" if metadata_storage.is_dir() else metadata_storage
        metadata_id = metadata_file.parent.name
        metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
        if metadata.get("Name") != CONTEXT or metadata.get("Endpoints", {}).get("docker", {}).get("Host") != endpoint:
            raise ValidationError("Docker context metadata does not match its inspected identity")
        destination = config_dir / "contexts" / "meta" / metadata_id
        destination.mkdir(parents=True)
        shutil.copyfile(metadata_file, destination / "meta.json")
        (config_dir / "config.json").write_text('{"auths":{}}\n', encoding="utf-8")
        config_dir.chmod(0o700)
        global DOCKER_ENV
        DOCKER_ENV = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", str(Path.home())),
            "TMPDIR": os.environ.get("TMPDIR", tempfile.gettempdir()),
            "LC_ALL": "C",
            "DOCKER_CONFIG": str(config_dir),
        }
        info = json.loads(docker(["info", "--format", "{{json .}}"]))
    except BaseException:
        shutil.rmtree(config_dir, ignore_errors=True)
        DOCKER_ENV = None
        raise
    if info.get("Architecture") != "aarch64" and info.get("Architecture") != "arm64":
        shutil.rmtree(config_dir, ignore_errors=True)
        DOCKER_ENV = None
        raise ValidationError("Docker Engine is not native ARM64")
    if not isinstance(info.get("Name"), str) or "jarvis" not in info["Name"].lower():
        shutil.rmtree(config_dir, ignore_errors=True)
        DOCKER_ENV = None
        raise ValidationError("Docker Engine identity is not the dedicated jarvis profile")
    return config_dir


def assert_scenario_results(output):
    results = required_scenario_results(output)
    if any(result["result"] != "passed" for result in results):
        raise ValidationError("requested integration scenario did not execute and pass")


def run_validation(args):
    global ACTIVE_PROCESS, DOCKER_ENV, INTERRUPT_PENDING
    workspace = Path(args.workspace).resolve(strict=True)
    versions = Path(args.versions).resolve(strict=True)
    expected_base, expected_head = args.expected_base, args.expected_head
    if not SHA_PATTERN.fullmatch(expected_base) or not SHA_PATTERN.fullmatch(expected_head):
        raise ValidationError("expected base and head must be full lowercase commit SHAs")
    if not workspace.is_dir():
        raise ValidationError("validation workspace is not a directory")
    if versions != trusted_versions_file().resolve(strict=True):
        raise ValidationError("PostgreSQL pins must come from the trusted runner's base checkout")
    if workspace == versions or workspace in versions.parents:
        raise ValidationError("PostgreSQL pins must come from outside the candidate workspace")

    run_id = uuid.uuid4().hex
    name = f"jarvis-issue214-{run_id}"
    volume = f"{name}-data"
    database = f"jarvis_issue8_{run_id}"
    user = f"jv{run_id[:20]}"
    password = secrets.token_urlsafe(36)
    label = "org.jarvis.issue214.run"
    resource_label = f"{label}={run_id}"
    lock = Path(tempfile.gettempdir()) / "jarvis-issue214-persistence-validation.lock"
    lock_owned = False
    lock_inode = None
    docker_config = None
    pnpm_home = None
    pnpm_store = None
    env_path = None
    container_id = None
    volume_requested = False
    image = None
    platform = None
    process_tree_safe = True
    workspace_preverified = False
    build_outputs = expected_build_outputs(workspace)
    test_report = None
    failure = None
    status = "failed"
    base_head = {"base": expected_base, "head": expected_head}
    cleanup_errors = []

    try:
        trusted_identity = verify_trusted_runner_checkout(expected_base, workspace, versions)
        emit("trusted_runner_verified", base=expected_base, runner_head=trusted_identity["head"], run_id=run_id)
        image, platform = read_pins(versions)
        verified = verify_workspace(workspace, expected_base, expected_head)
        if verified != base_head:
            raise ValidationError("validation workspace revisions do not match expected base/head")
        workspace_preverified = True
        emit("workspace_verified", **verified, run_id=run_id, provenance="reviewer-executed")
        if any(path.exists() or path.is_symlink() for path in build_outputs):
            raise ValidationError("fresh validation workspace already contains dependency/build outputs")
        pnpm_executable, pnpm_version = validate_workspace_package_setup(workspace)
        emit("preflight_passed", **base_head, package_manager=f"pnpm@{pnpm_version}", run_id=run_id)

        # The shared lock is acquired only after the exact source and safe script set pass preflight.
        with defer_interrupts():
            try:
                lock.mkdir(mode=0o700)
            except FileExistsError as error:
                raise ValidationError("another validation run may be active; refusing a concurrent run") from error
            lock_owned = True
            lock_inode = lock.stat().st_ino
            owner = lock / "owner"
            owner.write_text(run_id, encoding="ascii")
            owner.chmod(0o600)

        with defer_interrupts():
            pnpm_home = Path(tempfile.mkdtemp(prefix=f"jarvis-pnpm-home-{run_id}-"))
            pnpm_store = Path(tempfile.mkdtemp(prefix=f"jarvis-pnpm-store-{run_id}-"))
        node_executable = resolve_tool_executable("node")
        setup_env = package_manager_environment(pnpm_home, pnpm_store, node_executable, pnpm_executable)
        version_result = run([str(pnpm_executable), "--version"], cwd=workspace, env=setup_env)
        if version_result != pnpm_version:
            raise ValidationError("available pnpm version does not match the pinned packageManager")
        node_version = run([str(node_executable), "--version"], cwd=workspace, env=setup_env)
        if not re.fullmatch(r"v24\.[0-9]+\.[0-9]+", node_version):
            raise ValidationError("Node.js must satisfy the trusted workspace's Node 24 requirement")
        resolved_store = verify_package_manager_store(pnpm_executable, workspace, setup_env, pnpm_store)
        emit("package_store_verified", **base_head, store=str(resolved_store), run_id=run_id,
             provenance="reviewer-executed")

        install_command = [str(pnpm_executable), "--store-dir", str(pnpm_store),
                           "install", "--frozen-lockfile", "--ignore-scripts"]
        install = run_managed(install_command, cwd=workspace, env=setup_env, timeout=SETUP_TIMEOUT)
        emit("dependency_setup", **base_head,
             command=["pnpm", "--store-dir", str(pnpm_store), "install", "--frozen-lockfile", "--ignore-scripts"],
             package_manager=f"pnpm@{pnpm_version}", node=node_version, exit_code=install["exit_code"],
             timed_out=install["timed_out"], process_tree_stopped=install["tree_stopped"], run_id=run_id,
             provenance="reviewer-executed")
        if install["interrupted"]:
            raise KeyboardInterrupt
        if install["timed_out"] or install["exit_code"] != 0 or not install["tree_stopped"]:
            raise ValidationError("frozen dependency setup did not complete successfully")

        with defer_interrupts():
            docker_config = verify_engine()
        emit("engine_verified", **base_head, context=CONTEXT, platform=platform, run_id=run_id,
             provenance="reviewer-executed")

        volume_requested = True
        emit("resources_requested", **base_head, context=CONTEXT, image=image,
             platform=platform, run_id=run_id)
        docker(["volume", "create", "--label", resource_label, volume])
        volume_identity = json.loads(docker(["volume", "inspect", volume]))
        if (not isinstance(volume_identity, list) or len(volume_identity) != 1
                or volume_identity[0].get("Name") != volume
                or volume_identity[0].get("Labels", {}).get(label) != run_id):
            raise ValidationError("created volume identity did not match; refusing to mount it")
        with defer_interrupts():
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="jarvis-pg-", delete=False) as env_file:
                env_path = Path(env_file.name)
                env_path.chmod(0o600)
                env_file.write(f"POSTGRES_USER={user}\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB={database}\n")
        container_id = name  # Reconciles a container even if the Docker CLI loses its response.
        created_id = docker([
            "run", "--detach", "--name", name, "--label", resource_label,
            "--platform", platform, "--publish", "127.0.0.1::5432",
            "--mount", f"type=volume,src={volume},dst=/var/lib/postgresql",
            "--health-cmd", f"pg_isready -U {user} -d {database}",
            "--health-interval", "2s", "--health-timeout", "2s", "--health-retries", "45",
            "--env-file", str(env_path), image,
        ])
        created_id = created_id.strip()
        if not re.fullmatch(r"[0-9a-f]{12,64}", created_id):
            raise ValidationError("Docker returned an invalid container identity")
        container_id = created_id
        env_path.unlink()
        env_path = None

        inspect = json.loads(docker(["inspect", container_id]))[0]
        if inspect.get("Id", "").startswith(container_id) is False:
            raise ValidationError("created container identity did not match")
        config = inspect.get("Config", {})
        if config.get("Image") != image or config.get("Labels", {}).get(label) != run_id:
            raise ValidationError("created container identity labels or image did not match")
        mounts = inspect.get("Mounts", [])
        if len(mounts) != 1 or mounts[0].get("Name") != volume or mounts[0].get("Type") != "volume":
            raise ValidationError("container mount identity did not match its disposable volume")
        port = docker(["port", container_id, "5432/tcp"])
        match = re.fullmatch(r"127\.0\.0\.1:(\d+)", port)
        if not match:
            raise ValidationError("PostgreSQL was not published on loopback only")
        host_port = match.group(1)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            state = json.loads(docker(["inspect", "--format", "{{json .State}}", container_id]))
            if state.get("Status") == "running" and state.get("Health", {}).get("Status") == "healthy":
                break
            if state.get("Status") in {"exited", "dead"}:
                raise ValidationError("PostgreSQL container exited before becoming healthy")
            time.sleep(2)
        else:
            raise ValidationError("PostgreSQL container did not become healthy")

        test_env = dict(setup_env)
        test_env["JARVIS_TEST_DATABASE_URL"] = f"postgresql://{user}:{password}@127.0.0.1:{host_port}/{database}"
        test_env["JARVIS_RUN_STOP_RUNTIME_INTEGRATION"] = "1"
        test_command = [str(pnpm_executable), "--store-dir", str(pnpm_store), *PACKAGE_COMMAND[1:]]
        emit("test_started", **base_head, command=PACKAGE_COMMAND, executable=str(pnpm_executable),
             timeout_seconds=TEST_TIMEOUT, run_id=run_id, provenance="reviewer-executed")
        test_report = run_managed(test_command, cwd=workspace, env=test_env, timeout=TEST_TIMEOUT)
        summary = parse_test_summary(test_report["output"])
        scenario_results = required_scenario_results(test_report["output"])
        test_summary = {
            "total": summary.get("total") if summary else None,
            "pass": summary.get("pass") if summary else None,
            "fail": summary.get("fail") if summary else None,
            "skip": summary.get("skip") if summary else None,
        }
        emit("test_result", **base_head, provenance="reviewer-executed", exit_code=test_report["exit_code"],
             timed_out=test_report["timed_out"], interrupted=test_report["interrupted"],
             process_tree_stopped=test_report["tree_stopped"], summary=test_summary,
             required_scenarios=scenario_results, run_id=run_id)
        if test_report["interrupted"]:
            raise KeyboardInterrupt
        if test_report["timed_out"]:
            raise ValidationError("persistence tests exceeded their timeout")
        if test_report["exit_code"] != 0 or not summary or summary["fail"] != 0:
            raise ValidationError("persistence test process did not report a passing test summary")
        assert_scenario_results(test_report["output"])
        if any(result["result"] != "passed" for result in scenario_results):
            raise ValidationError("requested integration scenario did not execute and pass")
        post_test_identity = verify_workspace(workspace, expected_base, expected_head)
        if post_test_identity != base_head:
            raise ValidationError("validation workspace revisions changed during the test run")
        status = "passed"
    except KeyboardInterrupt as error:
        failure = error
        status = "interrupted"
    except Exception as error:
        failure = error
        status = "failed"
    finally:
        # Defer new signals until every applicable cleanup action has completed.
        with defer_interrupts(raise_pending=False):
            if ACTIVE_PROCESS is not None:
                try:
                    stop_process_tree(ACTIVE_PROCESS)
                except ProcessTreeError:
                    process_tree_safe = False
                    cleanup_errors.append("could not establish that the active process tree stopped")

            if env_path is not None:
                try:
                    env_path.unlink(missing_ok=True)
                except OSError:
                    cleanup_errors.append("ephemeral credential file cleanup failed")

            if process_tree_safe:
                for directory, description in ((pnpm_home, "isolated package-manager home"),
                                               (pnpm_store, "isolated package-manager store")):
                    if directory is not None:
                        try:
                            shutil.rmtree(directory)
                        except OSError:
                            cleanup_errors.append(f"{description} cleanup failed")
                try:
                    removed = remove_expected_build_outputs(build_outputs, workspace)
                    if removed:
                        emit("generated_outputs_removed", **base_head, paths=removed, run_id=run_id)
                except (ValidationError, OSError):
                    cleanup_errors.append("generated package outputs could not be safely reconciled")

                cleanup_errors.extend(cleanup_docker_resources(
                    container_id, volume_requested, name=name, volume=volume, label=label,
                    run_id=run_id, image=image,
                ))

                if workspace_preverified:
                    try:
                        verify_workspace(workspace, expected_base, expected_head)
                    except ValidationError:
                        cleanup_errors.append("validation workspace revisions/integrity could not be confirmed")
            elif lock_owned:
                cleanup_errors.append("run lock and disposable resources retained because a process may still be active")

            if lock_owned and process_tree_safe:
                try:
                    if (lock.is_symlink() or not lock.is_dir() or lock.stat().st_ino != lock_inode
                            or (lock / "owner").read_text(encoding="ascii") != run_id):
                        cleanup_errors.append("validation lock identity changed; left untouched")
                    else:
                        shutil.rmtree(lock)
                except OSError:
                    cleanup_errors.append("validation lock cleanup failed")

            if docker_config is None and DOCKER_ENV and DOCKER_ENV.get("DOCKER_CONFIG"):
                docker_config = Path(DOCKER_ENV["DOCKER_CONFIG"])
            if docker_config is not None and process_tree_safe:
                try:
                    shutil.rmtree(docker_config)
                    DOCKER_ENV = None
                except OSError:
                    cleanup_errors.append("credential-free Docker configuration cleanup failed")
            elif docker_config is not None:
                cleanup_errors.append("credential-free Docker configuration retained because a process may still be active")

    if INTERRUPT_PENDING:
        INTERRUPT_PENDING = False
        status = "interrupted"
        if failure is None:
            failure = KeyboardInterrupt()
        cleanup_errors.append("interrupt received during cleanup; cleanup sequence completed")
    if cleanup_errors:
        status = "cleanup_incomplete"
        emit("cleanup_incomplete", **base_head, run_id=run_id, reasons=cleanup_errors)
        if failure is None:
            failure = ValidationError("owned resources could not all be safely cleaned up")
    else:
        emit("cleanup_complete", **base_head, run_id=run_id)
    emit("result", **base_head, run_id=run_id, status=status,
         provenance="reviewer-executed" if test_report is not None else "preflight/setup")
    if failure is not None:
        raise failure


def main(argv=None):
    global INTERRUPT_PENDING
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True, help="exact prepared immutable validation workspace")
    parser.add_argument("--versions", required=True, help="trusted infra/colima/versions.env path")
    parser.add_argument("--expected-base", required=True, help="full target base commit SHA")
    parser.add_argument("--expected-head", required=True, help="full candidate head commit SHA")
    args = parser.parse_args(argv)
    INTERRUPT_PENDING = False
    signal.signal(signal.SIGTERM, interrupt_handler)
    signal.signal(signal.SIGINT, interrupt_handler)
    try:
        run_validation(args)
        return 0
    except KeyboardInterrupt:
        return 130
    except (ValidationError, OSError, ValueError, KeyError, IndexError, json.JSONDecodeError):
        # run_validation emits its revision-bound outcome after cleanup.
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
