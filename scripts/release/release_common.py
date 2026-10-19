"""Shared credential-safe Git/GitHub command helpers for package releases."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Iterator, Protocol, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


REPOSITORY = "grasdouble/Jarvis"
VERSION_BRANCH = "changesets/version"
VERSION_PR_TITLE = "build(release): update package versions"
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


@dataclass(frozen=True)
class PackageRelease:
    """A validated package release derived from one generated version PR."""

    package: str
    version: str
    tag: str
    notes: str


class ReleaseClient(Protocol):
    def tag_commit(self, tag: str) -> str | None: ...

    def create_tag(self, tag: str, commit_sha: str, message: str) -> None: ...

    def release(self, tag: str) -> dict | None: ...

    def create_release(
        self, tag: str, commit_sha: str, name: str, body: str
    ) -> dict: ...


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class GitHubReleaseClient:
    """Small GitHub REST client for immutable package tags and releases."""

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

    @staticmethod
    def _tag_endpoint(tag: str) -> str:
        return f"git/ref/tags/{quote(tag, safe='/-._~')}"

    def tag_commit(self, tag: str) -> str | None:
        status, reference = self.request("GET", self._tag_endpoint(tag))
        if status == 404:
            return None
        if status != 200 or not isinstance(reference, dict):
            raise ReleaseError(f"Could not inspect package tag {tag!r} (HTTP {status}).")
        object_data = reference.get("object")
        visited: set[str] = set()
        for _ in range(8):
            if not isinstance(object_data, dict):
                break
            object_type = object_data.get("type")
            object_sha = object_data.get("sha")
            if not isinstance(object_sha, str) or not object_sha:
                break
            if object_type == "commit":
                return object_sha
            if object_type != "tag" or object_sha in visited:
                break
            visited.add(object_sha)
            status, object_data = self.request("GET", f"git/tags/{object_sha}")
            if status != 200 or not isinstance(object_data, dict):
                break
            object_data = object_data.get("object")
        raise ReleaseError(f"Package tag {tag!r} does not resolve to a commit.")

    def create_tag(self, tag: str, commit_sha: str, message: str) -> None:
        status, tag_object = self.request(
            "POST",
            "git/tags",
            {"tag": tag, "message": message, "object": commit_sha, "type": "commit"},
        )
        if (
            status != 201
            or not isinstance(tag_object, dict)
            or not isinstance(tag_object.get("sha"), str)
        ):
            raise ReleaseError(f"Could not create annotated package tag {tag!r} (HTTP {status}).")
        status, _ = self.request(
            "POST",
            "git/refs",
            {"ref": f"refs/tags/{tag}", "sha": tag_object["sha"]},
        )
        if status == 201:
            return
        # A competing/retried ref creation is reconciled by the caller against its commit.
        if status in {409, 422}:
            return
        raise ReleaseError(f"Could not create package tag reference {tag!r} (HTTP {status}).")

    def release(self, tag: str) -> dict | None:
        status, result = self.request("GET", f"releases/tags/{quote(tag, safe='/-._~')}")
        if status == 404:
            return None
        if status != 200 or not isinstance(result, dict):
            raise ReleaseError(f"Could not inspect GitHub Release for {tag!r} (HTTP {status}).")
        return result

    def create_release(self, tag: str, commit_sha: str, name: str, body: str) -> dict:
        status, result = self.request(
            "POST",
            "releases",
            {
                "tag_name": tag,
                "target_commitish": commit_sha,
                "name": name,
                "body": body,
                "draft": False,
                "prerelease": False,
            },
        )
        if status == 201 and isinstance(result, dict):
            return result
        # The caller rereads the release after a conflict or uncertain server outcome.
        if status in {409, 422}:
            existing = self.release(tag)
            if existing is not None:
                return existing
        raise ReleaseError(f"Could not create GitHub Release for {tag!r} (HTTP {status}).")


def publish_release(
    client: ReleaseClient,
    artifact: PackageRelease,
    commit_sha: str,
) -> None:
    """Create one immutable tag/release, reconciling completed partial attempts."""
    expected_name = f"{artifact.package}@{artifact.version}"
    existing_release = client.release(artifact.tag)
    existing_commit = client.tag_commit(artifact.tag)
    if existing_commit is None and existing_release is not None:
        raise ReleaseError(
            f"GitHub Release {artifact.tag!r} exists without its immutable Git tag; "
            "refusing repair."
        )
    if existing_commit is None:
        client.create_tag(
            artifact.tag,
            commit_sha,
            f"{expected_name}\n\nReleased from {commit_sha}.",
        )
        existing_commit = client.tag_commit(artifact.tag)
    if existing_commit != commit_sha:
        raise ReleaseError(
            f"Package tag {artifact.tag!r} points to {existing_commit!r}, "
            "not the verified release commit."
        )

    if existing_release is None:
        try:
            existing_release = client.create_release(
                artifact.tag,
                commit_sha,
                expected_name,
                artifact.notes,
            )
        except ReleaseError:
            # A lost create response may have committed the release. Reconcile exactly once.
            existing_release = client.release(artifact.tag)
            if existing_release is None:
                raise
    expected = {
        "tag_name": artifact.tag,
        "target_commitish": commit_sha,
        "name": expected_name,
        "body": artifact.notes,
        "draft": False,
        "prerelease": False,
    }
    mismatches = [key for key, value in expected.items() if existing_release.get(key) != value]
    if mismatches:
        raise ReleaseError(
            f"GitHub Release for {artifact.tag!r} conflicts in fields: {', '.join(mismatches)}."
        )
