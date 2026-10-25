"""Shared credential-safe Git/GitHub command helpers for package releases."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Iterator, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPOSITORY = "grasdouble/Jarvis"
GITHUB_API = "https://api.github.com"


class ReleaseError(RuntimeError):
    """A release operation stopped without guessing at remote state."""


def safe_process(
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
    check: bool = True,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(command),
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        input=input_text,
        check=False,
    )
    token = env.get("GH_TOKEN", "")
    stdout = result.stdout.replace(token, "[REDACTED]") if token else result.stdout
    stderr = result.stderr.replace(token, "[REDACTED]") if token else result.stderr
    sanitized = subprocess.CompletedProcess(command, result.returncode, stdout, stderr)
    if check and result.returncode:
        detail = (stderr or stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise ReleaseError(f"Command failed ({command[0]}): exit {result.returncode}{suffix}")
    return sanitized


@contextmanager
def github_app_environment(token: str) -> Iterator[dict[str, str]]:
    """Use only the supplied installation token for Git and gh; never ambient login."""
    if not token:
        raise ReleaseError("The dedicated package-release App token is unavailable.")
    with tempfile.TemporaryDirectory(prefix="jarvis-package-release-auth-") as temporary:
        directory = Path(temporary)
        askpass = directory / "askpass.sh"
        askpass.write_text(
            "#!/bin/sh\n"
            "case \"$1\" in\n"
            "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
            "  *Password*) printf '%s\\n' \"$GH_TOKEN\" ;;\n"
            "  *) exit 1 ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        askpass.chmod(0o700)
        environment = os.environ.copy()
        for name in (
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_PARAMETERS",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
        ):
            environment.pop(name, None)
        for name in tuple(environment):
            if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
                environment.pop(name, None)
        environment.update(
            GH_TOKEN=token,
            GH_HOST="github.com",
            GH_CONFIG_DIR=str(directory / "gh-config"),
            GH_PROMPT_DISABLED="1",
            GIT_ASKPASS=str(askpass),
            GIT_TERMINAL_PROMPT="0",
            GIT_CONFIG_GLOBAL=os.devnull,
            GIT_CONFIG_NOSYSTEM="1",
        )
        yield environment


def verify_app_identity(environment: dict[str, str]) -> None:
    """Compare create-github-app-token outputs to owner-provisioned expected identity."""
    expected_slug = environment.get("PACKAGE_RELEASE_APP_SLUG", "")
    expected_installation = environment.get("PACKAGE_RELEASE_APP_INSTALLATION_ID", "")
    actual_slug = environment.get("RELEASE_TOKEN_APP_SLUG", "")
    actual_installation = environment.get("RELEASE_TOKEN_INSTALLATION_ID", "")
    if not expected_slug or not expected_installation:
        raise ReleaseError("The expected package-release App identity is not configured.")
    if not expected_slug.isascii() or not all(
        character.isalnum() or character == "-" for character in expected_slug
    ):
        raise ReleaseError("PACKAGE_RELEASE_APP_SLUG must be an ASCII GitHub App slug.")
    if not expected_installation.isdecimal() or int(expected_installation) <= 0:
        raise ReleaseError("PACKAGE_RELEASE_APP_INSTALLATION_ID must be a positive integer.")
    if actual_slug != expected_slug or actual_installation != expected_installation:
        raise ReleaseError(
            "The installation token does not match the configured package-release App."
        )


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class GitHubReleaseClient:
    """Small repository-scoped GitHub REST client for release preflight reads."""

    def __init__(self, token: str, repository: str = REPOSITORY) -> None:
        if not token:
            raise ReleaseError("The dedicated package-release App token is unavailable.")
        if repository != REPOSITORY:
            raise ReleaseError("Package releases are restricted to the configured repository.")
        self._token = token
        self._base = f"{GITHUB_API}/repos/{REPOSITORY}"
        self._opener = build_opener(_NoRedirect())

    def request(
        self, method: str, endpoint: str, payload: dict | None = None
    ) -> tuple[int, object]:
        if endpoint.startswith("/") or ".." in endpoint.split("/"):
            raise ReleaseError("Refusing an invalid GitHub API endpoint.")
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            f"{self._base}/{endpoint}",
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with self._opener.open(request, timeout=20) as response:
                status = response.status
                raw = response.read()
        except HTTPError as error:
            status = error.code
            raw = error.read()
            error.close()
        except (OSError, TimeoutError, URLError) as error:
            # Do not echo the request, headers, or transport exception (which may contain URLs).
            raise ReleaseError(f"GitHub API transport failed for {method} {endpoint}.") from error
        if not raw:
            return status, None
        try:
            result = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ReleaseError(
                f"GitHub API returned invalid JSON for {method} {endpoint}."
            ) from error
        return status, result
