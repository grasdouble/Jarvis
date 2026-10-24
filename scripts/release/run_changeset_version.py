"""Run Changesets versioning and its generated-version validation without the write token."""

from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys

from release_common import ReleaseError, safe_process


ROOT = Path(__file__).resolve().parents[2]


def run() -> None:
    base_sha = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40,64}", base_sha):
        raise ReleaseError("GITHUB_SHA must identify the trusted main revision.")

    command_environment = os.environ.copy()
    for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
        command_environment.pop(name, None)
    safe_process(
        ["pnpm", "changeset", "version"],
        cwd=ROOT,
        env=command_environment,
    )
    safe_process(
        ["pnpm", "install", "--lockfile-only"],
        cwd=ROOT,
        env=command_environment,
    )
    safe_process(
        [sys.executable, str(ROOT / "scripts/ci/check_changeset_pr.py"), base_sha],
        cwd=ROOT,
        env=command_environment,
    )


def main() -> int:
    try:
        run()
    except (OSError, subprocess.CalledProcessError, ReleaseError) as error:
        print(f"Changesets version generation failed closed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
