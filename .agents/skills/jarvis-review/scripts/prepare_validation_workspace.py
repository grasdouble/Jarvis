#!/usr/bin/env python3
"""Prepare and verify an exact-commit contributor review workspace."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile


SCHEMA_VERSION = 1
MANIFEST_RELATIVE_PATH = Path(".git") / "jarvis-validation" / "manifest.json"
COMMIT_PATTERN = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
GIT_TIMEOUT_SECONDS = 120


class WorkspaceError(Exception):
    """An invalid request or an unavailable/unsafe Git operation."""


class WorkspaceMismatch(Exception):
    """A prepared workspace no longer matches its source manifest."""


def git_environment(home):
    """Return a narrow environment that cannot inherit GitHub or provider credentials."""
    return {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_LFS_SKIP_SMUDGE": "1",
        "GIT_ALLOW_PROTOCOL": "file",
        "LC_ALL": "C",
    }


def run_git(args, *, cwd=None, env, check=True):
    command = [
        "git",
        "-c", "core.hooksPath=" + os.devnull,
        "-c", "core.fsmonitor=false",
        "-c", "core.untrackedCache=false",
        "-c", "core.alternateRefsCommand=",
    ]
    if cwd is not None:
        command.extend(["-C", str(cwd)])
    command.extend(args)
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise WorkspaceError(f"Could not complete Git operation: {args[0]}.") from error
    if check and result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip().splitlines()
        suffix = f" {detail[-1][:240]}" if detail else ""
        raise WorkspaceError(f"Git operation failed: {args[0]} (exit {result.returncode}).{suffix}")
    return result


def git_text(args, *, cwd, env):
    return run_git(args, cwd=cwd, env=env).stdout.decode("ascii").strip()


def resolve_commit(value, *, repo, object_format, env):
    if not COMMIT_PATTERN.fullmatch(value):
        raise WorkspaceError("Base and head must be full lowercase commit IDs.")
    expected_length = 40 if object_format == "sha1" else 64
    if len(value) != expected_length:
        raise WorkspaceError(f"Commit ID length does not match the repository's {object_format} format.")
    resolved = git_text(["rev-parse", "--verify", f"{value}^{{commit}}"], cwd=repo, env=env)
    if resolved != value:
        raise WorkspaceError("The requested commit ID did not resolve exactly.")
    return value


def relative_path_parts(path):
    """Validate a Git path as portable, workspace-relative path bytes."""
    if not path or path.startswith(b"/") or b"\x00" in path or b"\\" in path:
        raise WorkspaceError("The source tree contains a non-portable path.")
    parts = path.split(b"/")
    if any(part in (b"", b".", b"..") for part in parts):
        raise WorkspaceError("The source tree contains an unsafe relative path.")
    decoded = os.fsdecode(path)
    windows_path = PureWindowsPath(decoded)
    if windows_path.is_absolute() or windows_path.drive or parts[0].lower() == b".git":
        raise WorkspaceError("The source tree contains a reserved or absolute path.")
    return parts


def symlink_stays_inside(path, target):
    if not target or b"\x00" in target:
        return False
    decoded = os.fsdecode(target)
    windows_target = PureWindowsPath(decoded)
    if target.startswith(b"/") or b"\\" in target or windows_target.is_absolute() or windows_target.drive:
        return False
    depth = len(path.split(b"/")) - 1
    for part in target.split(b"/"):
        if part in (b"", b"."):
            continue
        if part == b"..":
            depth -= 1
            if depth < 0:
                return False
        else:
            depth += 1
    return True


def parse_tree(raw, *, repo, env):
    entries = []
    for record in raw.split(b"\x00"):
        if not record:
            continue
        try:
            metadata, path = record.split(b"\t", 1)
            mode_bytes, object_type, object_id_bytes = metadata.split(b" ", 2)
            mode = mode_bytes.decode("ascii")
            object_id = object_id_bytes.decode("ascii")
        except (ValueError, UnicodeDecodeError) as error:
            raise WorkspaceError("Git returned an invalid tree entry.") from error

        relative_path_parts(path)
        if mode == "160000" or object_type == b"commit":
            raise WorkspaceError("Submodules are not supported in validation snapshots.")
        if (mode, object_type) not in {
            ("100644", b"blob"),
            ("100755", b"blob"),
            ("120000", b"blob"),
        }:
            raise WorkspaceError("The source tree contains an unsupported file type.")
        if mode == "120000":
            target = run_git(["cat-file", "blob", object_id], cwd=repo, env=env).stdout
            if not symlink_stays_inside(path, target):
                raise WorkspaceError(
                    f"The source tree has a symlink that escapes the workspace: {os.fsdecode(path)!r}."
                )
        entries.append({
            "path_b64": base64.b64encode(path).decode("ascii"),
            "mode": mode,
            "blob": object_id,
        })
    entries.sort(key=lambda item: base64.b64decode(item["path_b64"]))
    return entries


def canonical_manifest_bytes(manifest):
    value = dict(manifest)
    value.pop("manifest_sha256", None)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def save_manifest(workspace, manifest):
    manifest["manifest_sha256"] = hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()
    manifest_path = workspace / MANIFEST_RELATIVE_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("x", encoding="utf-8") as output:
        json.dump(manifest, output, sort_keys=True, indent=2)
        output.write("\n")
    manifest_path.chmod(0o600)


def load_manifest(workspace):
    manifest_path = workspace / MANIFEST_RELATIVE_PATH
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkspaceError("The validation manifest is missing or invalid.") from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
        raise WorkspaceError("The validation manifest has an unsupported schema.")
    digest = manifest.get("manifest_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise WorkspaceError("The validation manifest checksum is missing or invalid.")
    expected = hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()
    if digest != expected:
        raise WorkspaceError("The validation manifest checksum does not match.")
    source = manifest.get("source")
    entries = manifest.get("entries")
    if not isinstance(source, dict) or not isinstance(entries, list):
        raise WorkspaceError("The validation manifest is incomplete.")
    return manifest


def validate_source(repo_path, base, head, env):
    try:
        supplied = Path(repo_path).resolve(strict=True)
    except OSError as error:
        raise WorkspaceError("The source repository does not exist.") from error
    if not supplied.is_dir():
        raise WorkspaceError("The source repository path must be a directory.")
    root = Path(git_text(["rev-parse", "--show-toplevel"], cwd=supplied, env=env)).resolve()
    if root != supplied:
        raise WorkspaceError("--repo must name the repository root.")
    if run_git(
        ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"],
        cwd=root,
        env=env,
    ).stdout:
        raise WorkspaceError("The source checkout has tracked, staged, or untracked changes.")
    object_format = git_text(["rev-parse", "--show-object-format"], cwd=root, env=env)
    if object_format not in {"sha1", "sha256"}:
        raise WorkspaceError("The source repository uses an unsupported Git object format.")
    base = resolve_commit(base, repo=root, object_format=object_format, env=env)
    head = resolve_commit(head, repo=root, object_format=object_format, env=env)
    if git_text(["rev-parse", "HEAD"], cwd=root, env=env) != head:
        raise WorkspaceError("The source checkout HEAD must equal the requested candidate head.")
    refs = run_git(
        ["for-each-ref", "--format=%(objectname) %(refname)"],
        cwd=root,
        env=env,
    ).stdout.decode("ascii").splitlines()
    base_refs = sorted(
        fields[1] for line in refs
        if len(fields := line.split(" ", 1)) == 2 and fields[0] == base
    )
    if not base_refs:
        raise WorkspaceError(
            "The exact base commit must be the target of an existing local Git ref; fetch or select it first."
        )
    merge_base = git_text(["merge-base", base, head], cwd=root, env=env)
    head_tree = git_text(["rev-parse", f"{head}^{{tree}}"], cwd=root, env=env)
    tree = run_git(["ls-tree", "-r", "-z", "--full-tree", head], cwd=root, env=env).stdout
    entries = parse_tree(tree, repo=root, env=env)
    return root, object_format, base, head, merge_base, head_tree, entries, base_refs[0]


def destination_path(value, *, source_root, common_dir):
    supplied = Path(value).expanduser()
    if supplied.exists() or supplied.is_symlink():
        raise WorkspaceError("The destination must not already exist.")
    destination = supplied.resolve(strict=False)
    if destination.exists() or destination.is_symlink():
        raise WorkspaceError("The destination must not already exist.")
    if not destination.parent.is_dir():
        raise WorkspaceError("The destination parent directory must already exist.")
    if destination == source_root or source_root in destination.parents or destination in source_root.parents:
        raise WorkspaceError("The destination must be outside the source checkout.")
    if destination == common_dir or common_dir in destination.parents or destination in common_dir.parents:
        raise WorkspaceError("The destination must be outside the Git metadata directory.")
    return destination


def prepare(args):
    with tempfile.TemporaryDirectory(prefix="jarvis-review-helper-") as private_temp:
        temp_root = Path(private_temp)
        home = temp_root / "home"
        home.mkdir()
        env = git_environment(home)
        source_root, object_format, base, head, merge_base, head_tree, entries, base_ref = validate_source(
            args.repo, args.base, args.head, env
        )
        common_dir = Path(git_text(["rev-parse", "--git-common-dir"], cwd=source_root, env=env))
        if not common_dir.is_absolute():
            common_dir = (source_root / common_dir).resolve()
        else:
            common_dir = common_dir.resolve()
        destination = destination_path(
            args.destination, source_root=source_root, common_dir=common_dir
        )

        bundle = temp_root / "source.bundle"
        run_git(
            ["bundle", "create", str(bundle), "HEAD", base_ref],
            cwd=source_root,
            env=env,
        )
        run_git(["bundle", "verify", str(bundle)], cwd=source_root, env=env)

        staging = temp_root / "workspace"
        empty_template = temp_root / "empty-template"
        empty_template.mkdir()
        run_git([
            "init", "--quiet", "--template", str(empty_template),
            "--object-format", object_format, str(staging),
        ], env=env)
        run_git(
            ["fetch", "--quiet", "--no-tags", str(bundle), "HEAD", base_ref],
            cwd=staging,
            env=env,
        )
        run_git(["update-ref", "refs/jarvis/source/base", base], cwd=staging, env=env)
        run_git(["update-ref", "refs/jarvis/source/head", head], cwd=staging, env=env)
        run_git(["update-ref", "refs/jarvis/source/merge-base", merge_base], cwd=staging, env=env)
        run_git(["checkout", "--quiet", "--detach", "--force", head], cwd=staging, env=env)

        hooks = staging / ".git" / "hooks"
        if hooks.exists():
            shutil.rmtree(hooks)
        run_git(["config", "--local", "core.hooksPath", os.devnull], cwd=staging, env=env)

        actual_head = git_text(["rev-parse", "HEAD"], cwd=staging, env=env)
        actual_tree = git_text(["rev-parse", "HEAD^{tree}"], cwd=staging, env=env)
        git_config_digest = hashlib.sha256((staging / ".git" / "config").read_bytes()).hexdigest()
        if actual_head != head or actual_tree != head_tree:
            raise WorkspaceError("The prepared workspace does not match the requested head tree.")
        if run_git(["remote"], cwd=staging, env=env).stdout.strip():
            raise WorkspaceError("The prepared workspace unexpectedly contains a Git remote.")
        if run_git(
            ["status", "--porcelain=v1", "--untracked-files=all"],
            cwd=staging,
            env=env,
        ).stdout:
            raise WorkspaceError("The prepared workspace is not clean.")

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "source": {
                "object_format": object_format,
                "base": base,
                "head": head,
                "merge_base": merge_base,
                "head_tree": head_tree,
            },
            "workspace": {
                "head": actual_head,
                "tracked_file_count": len(entries),
            },
            "git_config_sha256": git_config_digest,
            "entries": entries,
        }
        save_manifest(staging, manifest)
        os.replace(staging, destination)

    return {
        "status": "prepared",
        "workspace": str(destination),
        "manifest": str(destination / MANIFEST_RELATIVE_PATH),
        "source": {
            "base": base,
            "head": head,
            "merge_base": merge_base,
            "head_tree": head_tree,
        },
        "tracked_file_count": len(entries),
    }


def iter_workspace_files(root):
    root_bytes = os.fsencode(root)
    pending = [root_bytes]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as children:
            for child in children:
                name = child.name
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, root_bytes)
                if relative == b".git":
                    continue
                info = os.stat(path, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    pending.append(path)
                else:
                    yield relative.replace(os.sep.encode(), b"/"), info


def git_blob_digest(path, object_format, mode, info):
    algorithm = hashlib.new(object_format)
    algorithm.update(f"blob {info.st_size}\0".encode("ascii"))
    if mode == "120000":
        content = os.readlink(path)
        if isinstance(content, str):
            content = os.fsencode(content)
        algorithm.update(content)
    else:
        flags = os.O_RDONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(path, flags)
        except OSError as error:
            raise WorkspaceMismatch("A tracked file cannot be read safely.") from error
        with os.fdopen(descriptor, "rb") as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_size != info.st_size:
                raise WorkspaceMismatch("A tracked file changed while it was being verified.")
            while chunk := source.read(1024 * 1024):
                algorithm.update(chunk)
    return algorithm.hexdigest()


def verify(args):
    try:
        workspace = Path(args.workspace).expanduser().resolve(strict=True)
    except OSError as error:
        raise WorkspaceError("The validation workspace does not exist.") from error
    git_dir = workspace / ".git"
    if not workspace.is_dir() or not git_dir.is_dir() or git_dir.is_symlink():
        raise WorkspaceError("The validation workspace must be a standalone Git checkout.")
    with tempfile.TemporaryDirectory(prefix="jarvis-review-verify-") as private_temp:
        home = Path(private_temp)
        env = git_environment(home)
        top = Path(git_text(["rev-parse", "--show-toplevel"], cwd=workspace, env=env)).resolve()
        if top != workspace:
            raise WorkspaceError("The validation workspace root does not match its Git root.")
        manifest = load_manifest(workspace)
        source = manifest["source"]
        workspace_info = manifest.get("workspace")
        if not isinstance(workspace_info, dict):
            raise WorkspaceError("The validation manifest has no workspace metadata.")
        object_format = source.get("object_format")
        base = source.get("base")
        head = source.get("head")
        merge_base = source.get("merge_base")
        head_tree = source.get("head_tree")
        if object_format not in {"sha1", "sha256"} or not all(
            isinstance(value, str) and COMMIT_PATTERN.fullmatch(value)
            for value in (base, head, merge_base)
        ):
            raise WorkspaceError("The validation manifest contains invalid revision data.")
        if git_text(["rev-parse", "--show-object-format"], cwd=workspace, env=env) != object_format:
            raise WorkspaceError("The validation repository object format changed.")
        mismatches = []
        if git_text(["rev-parse", "HEAD"], cwd=workspace, env=env) != head:
            mismatches.append("HEAD")
        if workspace_info.get("head") != head:
            mismatches.append("manifest-head")
        if workspace_info.get("tracked_file_count") != len(manifest["entries"]):
            mismatches.append("manifest-file-count")
        for name, revision in (
            ("base", base), ("head", head), ("merge-base", merge_base)
        ):
            ref = f"refs/jarvis/source/{name}"
            result = run_git(["rev-parse", "--verify", ref], cwd=workspace, env=env, check=False)
            if result.returncode or result.stdout.decode("ascii").strip() != revision:
                mismatches.append(f"ref:{name}")
        if git_text(["merge-base", base, head], cwd=workspace, env=env) != merge_base:
            mismatches.append("merge-base")
        if git_text(["write-tree"], cwd=workspace, env=env) != head_tree:
            mismatches.append("index-tree")
        expected_refs = {
            f"refs/jarvis/source/{name}": revision
            for name, revision in (
                ("base", base), ("head", head), ("merge-base", merge_base)
            )
        }
        ref_lines = run_git(
            ["for-each-ref", "--format=%(objectname) %(refname)"],
            cwd=workspace,
            env=env,
        ).stdout.decode("ascii").splitlines()
        actual_refs = {
            fields[1]: fields[0]
            for line in ref_lines
            if len(fields := line.split(" ", 1)) == 2
        }
        if actual_refs != expected_refs:
            mismatches.append("git-refs")
        try:
            config_digest = hashlib.sha256((git_dir / "config").read_bytes()).hexdigest()
        except OSError:
            config_digest = ""
        if config_digest != manifest.get("git_config_sha256"):
            mismatches.append("git-config")
        actual_tree = git_text(["rev-parse", f"{head}^{{tree}}"], cwd=workspace, env=env)
        if actual_tree != head_tree:
            mismatches.append("head-tree")
        tree_entries = parse_tree(
            run_git(["ls-tree", "-r", "-z", "--full-tree", head], cwd=workspace, env=env).stdout,
            repo=workspace,
            env=env,
        )
        if tree_entries != manifest["entries"]:
            mismatches.append("manifest-tree")
        if run_git(["remote"], cwd=workspace, env=env).stdout.strip():
            mismatches.append("git-remotes")
        if (git_dir / "hooks").exists() or (git_dir / "hooks").is_symlink():
            mismatches.append("git-hooks")

        expected = {}
        for entry in manifest["entries"]:
            try:
                relative = base64.b64decode(entry["path_b64"], validate=True)
                mode = entry["mode"]
                blob = entry["blob"]
            except (KeyError, TypeError, ValueError) as error:
                raise WorkspaceError("The validation manifest has an invalid file entry.") from error
            expected[relative] = (mode, blob)

        actual = {}
        for relative, info in iter_workspace_files(workspace):
            actual[relative] = info
        unexpected = sorted(set(actual) - set(expected))
        missing = sorted(set(expected) - set(actual))
        if unexpected:
            mismatches.append("added-files:" + ",".join(repr(os.fsdecode(item)) for item in unexpected[:5]))
        if missing:
            mismatches.append("missing-files:" + ",".join(repr(os.fsdecode(item)) for item in missing[:5]))
        for relative in set(expected) & set(actual):
            expected_mode, expected_blob = expected[relative]
            info = actual[relative]
            path = os.path.join(os.fsencode(workspace), relative.replace(b"/", os.sep.encode()))
            if expected_mode == "120000":
                actual_mode = "120000" if stat.S_ISLNK(info.st_mode) else "invalid"
            elif stat.S_ISREG(info.st_mode):
                actual_mode = "100755" if info.st_mode & 0o111 else "100644"
            else:
                actual_mode = "invalid"
            if actual_mode != expected_mode:
                mismatches.append(f"mode:{os.fsdecode(relative)!r}")
                continue
            if git_blob_digest(path, object_format, expected_mode, info) != expected_blob:
                mismatches.append(f"content:{os.fsdecode(relative)!r}")

        if mismatches:
            raise WorkspaceMismatch("Workspace integrity check failed: " + "; ".join(mismatches[:20]))
    return {
        "status": "verified",
        "workspace": str(workspace),
        "source": {
            "base": base,
            "head": head,
            "merge_base": merge_base,
            "head_tree": head_tree,
        },
        "tracked_file_count": len(expected),
    }


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare", help="create a clean snapshot from exact commits")
    prepare_parser.add_argument("--repo", required=True, help="trusted source checkout root")
    prepare_parser.add_argument("--base", required=True, help="full base commit ID")
    prepare_parser.add_argument("--head", required=True, help="full candidate head commit ID")
    prepare_parser.add_argument("--destination", required=True, help="new path outside the source checkout")
    verify_parser = commands.add_parser("verify", help="verify a prepared workspace against its manifest")
    verify_parser.add_argument("--workspace", required=True, help="prepared workspace path")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_arguments(argv)
    try:
        result = prepare(args) if args.command == "prepare" else verify(args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except WorkspaceMismatch as error:
        print(json.dumps({"status": "mismatch", "error": str(error)}, sort_keys=True))
        return 1
    except WorkspaceError as error:
        print(json.dumps({"status": "error", "error": str(error)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
