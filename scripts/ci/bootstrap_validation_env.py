"""Create or validate an isolated Python environment for trusted CI checks."""

import argparse
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
REQUIREMENTS = ROOT / ".github" / "requirements-ci.txt"


class BootstrapError(Exception):
    """An actionable validation-environment setup error."""


def interpreter_version(executable):
    result = subprocess.run(
        [str(executable), "-c", "import platform,sys; print(platform.python_implementation()); print('.'.join(map(str, sys.version_info[:2])))"],
        capture_output=True, text=True, check=False, timeout=30,
    )
    if result.returncode:
        raise BootstrapError(f"cannot run Python interpreter {executable}: {result.stderr.strip() or 'command failed'}")
    lines = result.stdout.strip().splitlines()
    if len(lines) != 2 or lines[0] != "CPython":
        raise BootstrapError(f"{executable} must be CPython 3.9 through 3.14")
    try:
        version = tuple(int(part) for part in lines[1].split("."))
    except ValueError as error:
        raise BootstrapError(f"cannot determine Python version for {executable}") from error
    if len(version) != 2 or not (3, 9) <= version < (3, 15):
        raise BootstrapError(f"{executable} is Python {lines[1]}; use CPython 3.9 through 3.14")
    return version


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=600)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or "command failed"
        raise BootstrapError(f"command failed ({result.returncode}): {command[0]}: {detail}")


def bootstrap(workspace, python):
    try:
        workspace = Path(workspace).expanduser().resolve(strict=True)
    except OSError as error:
        raise BootstrapError(f"workspace does not exist or cannot be resolved: {workspace}") from error
    if not workspace.is_dir():
        raise BootstrapError(f"workspace must be an existing directory: {workspace}")
    if not REQUIREMENTS.is_file():
        raise BootstrapError(f"trusted requirements file is missing: {REQUIREMENTS}")
    interpreter_version(python)
    environment = workspace / ".venv"
    if environment.is_symlink():
        raise BootstrapError(f"refusing to use symlinked environment: {environment}")
    if environment.exists():
        venv_python = environment / "bin" / "python"
        if not venv_python.is_file():
            raise BootstrapError(f"existing environment is malformed; refusing to replace it: {environment}")
        interpreter_version(venv_python)
    else:
        run([str(python), "-m", "venv", str(environment)])
        venv_python = environment / "bin" / "python"
        if not venv_python.is_file():
            raise BootstrapError(f"venv creation did not produce an interpreter: {venv_python}")
        interpreter_version(venv_python)
    run([
        str(venv_python), "-m", "pip", "--isolated", "install",
        "--require-hashes", "--only-binary=:all:", "-r", str(REQUIREMENTS),
    ])
    return environment


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", help="existing author or reviewer checkout to prepare")
    parser.add_argument("--python", default=sys.executable, help="CPython 3.9–3.14 executable used to create .venv")
    args = parser.parse_args(argv)
    try:
        environment = bootstrap(args.workspace, args.python)
    except (BootstrapError, OSError, subprocess.SubprocessError) as error:
        print(f"Validation environment setup failed: {error}", file=sys.stderr)
        return 1
    print(f"Validation environment ready: {environment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
