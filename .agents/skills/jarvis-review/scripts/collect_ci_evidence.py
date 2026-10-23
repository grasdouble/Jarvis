#!/usr/bin/env python3
"""Coordinator-only, read-only collection through an explicitly trusted gh-app.mjs."""

from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import signal
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlsplit, urlunsplit

from ci_evidence_packet import create_packet, serialize_packet, validate_packet


REPOSITORY = "grasdouble/Jarvis"
PROCESS_TIMEOUT_SECONDS = 30
MAX_HELPER_STDOUT_BYTES = 2 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
API_PAGE_SIZE = 100
MAX_API_PAGES = 20
_SHA = re.compile(r"^[0-9a-f]{40}$")
_API_FILTERS = {
    "jobs": "{total_count,jobs:[.jobs[]|{id,name,conclusion,started_at,completed_at,html_url}]}",
    "check_runs": "{total_count,check_runs:[.check_runs[]|{id,name,head_sha,conclusion,check_suite:{id:.check_suite.id},started_at,completed_at,html_url}]}",
}
_RUN_FILTER = (
    "{id,workflow_id,check_suite_id,name,event,conclusion,created_at,updated_at,html_url,head_sha,"
    "pull_requests:[.pull_requests[]|{number,base_sha:.base.sha,head_sha:.head.sha}]}"
)


class CollectionError(ValueError):
    """Sanitized, deliberately non-specific collection failure."""


class SanitizedArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        del message
        self.print_usage(sys.stderr)
        self.exit(2, "Invalid collector arguments; no packet was produced.\n")


@dataclass(frozen=True)
class CollectionRequest:
    helper_path: str
    pull_request_number: int
    base_sha: str
    head_sha: str
    run_id: int
    workflow: str
    event: str
    required_jobs: tuple[str, ...]
    required_checks: tuple[str, ...]
    repository: str = REPOSITORY


def _object(value: Any, required: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not required <= set(value):
        raise CollectionError(f"Invalid {label} response.")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _json_object(stdout: str, required: set[str], label: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout, object_pairs_hook=_unique_object)
    except (TypeError, ValueError):
        raise CollectionError(f"Invalid {label} JSON response.") from None
    return _object(value, required, label)


def _safe_timestamp(value: Any) -> str:
    if not isinstance(value, str):
        raise CollectionError("Required timestamp is missing.")
    # GitHub emits UTC ISO timestamps, commonly with +00:00 rather than Z.
    if value.endswith("+00:00"):
        return value[:-6] + "Z"
    if value.endswith("Z"):
        return value
    raise CollectionError("Timestamp is not UTC.")


def _repository_url(value: Any, expected_path: str) -> str:
    if not isinstance(value, str):
        raise CollectionError("Required GitHub URL is missing.")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username
        or parsed.password or parsed.query or parsed.fragment or parsed.path != expected_path
    ):
        raise CollectionError("GitHub URL does not match the requested repository resource.")
    return value


def _validate_request(request: CollectionRequest) -> Path:
    path = Path(request.helper_path)
    if not path.is_absolute() or path.name != "gh-app.mjs" or not path.is_file():
        raise CollectionError("An existing absolute trusted gh-app.mjs path is required.")
    candidate_root = Path(__file__).resolve().parents[4]
    try:
        path.resolve().relative_to(candidate_root)
    except ValueError:
        pass
    else:
        raise CollectionError("The App helper must be outside this candidate checkout.")
    if request.repository != REPOSITORY:
        raise CollectionError("The reviewed App helper is restricted to grasdouble/Jarvis.")
    if type(request.pull_request_number) is not int or request.pull_request_number <= 0:
        raise CollectionError("A positive pull request number is required.")
    if type(request.run_id) is not int or request.run_id <= 0:
        raise CollectionError("A positive workflow run ID is required.")
    if not _SHA.fullmatch(request.base_sha) or not _SHA.fullmatch(request.head_sha):
        raise CollectionError("Full lowercase expected base and head SHAs are required.")
    if not request.workflow or not request.event:
        raise CollectionError("Expected workflow and event names are required.")
    for values, label in ((request.required_jobs, "required jobs"), (request.required_checks, "required checks")):
        if not values or any(not isinstance(value, str) or not value.strip() for value in values):
            raise CollectionError(f"Explicit {label} are required.")
        if len(set(values)) != len(values):
            raise CollectionError(f"{label.title()} must be unique.")
    return path


def _clean_helper_environment() -> dict[str, str]:
    # Preserve only the basics needed to locate Node, the user's home/key, and temp storage.
    # In particular, do not pass unrelated provider, forge, GitHub, or proxy credentials.
    allowed = {"PATH", "HOME", "TMPDIR", "JARVIS_GITHUB_APP_KEY_FILE"}
    return {name: value for name, value in os.environ.items() if name in allowed}


def _stop_process_group(process: subprocess.Popen[bytes]) -> None:
    """Kill the isolated helper/gh process group and reap its direct child."""
    try:
        # The session is dedicated to this helper invocation, so SIGKILL cannot
        # affect unrelated processes and prevents ignored signals leaving children.
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            process.kill()
        except OSError:
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _bounded_process_output(argv: Sequence[str]) -> tuple[int, bytes, bytes]:
    if os.name != "posix":
        raise CollectionError("Process-group execution is unavailable; no packet was produced.")
    process = subprocess.Popen(
        argv,
        shell=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_clean_helper_environment(),
        close_fds=True,
        start_new_session=True,
    )
    assert process.stdout is not None and process.stderr is not None
    selector: selectors.BaseSelector | None = None
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline = time.monotonic() + PROCESS_TIMEOUT_SECONDS
    try:
        selector = selectors.DefaultSelector()
        for stream in streams:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CollectionError("Trusted App-helper timed out; no packet was produced.")
            for key, _ in selector.select(timeout=min(remaining, 0.25)):
                stream = key.fileobj
                output = streams[stream]
                # Read at most one byte beyond the limit, enough to detect overflow
                # without buffering an unbounded chunk from the pipe.
                read_size = min(READ_CHUNK_BYTES, MAX_HELPER_STDOUT_BYTES + 1 - len(output))
                chunk = os.read(stream.fileno(), read_size)
                if not chunk:
                    selector.unregister(stream)
                    continue
                if len(output) + len(chunk) > MAX_HELPER_STDOUT_BYTES:
                    raise CollectionError("Trusted App-helper response exceeded the output limit; no packet was produced.")
                output.extend(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CollectionError("Trusted App-helper timed out; no packet was produced.")
        try:
            return_code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise CollectionError("Trusted App-helper timed out; no packet was produced.") from None
        return return_code, bytes(streams[process.stdout]), bytes(streams[process.stderr])
    except BaseException:
        _stop_process_group(process)
        raise
    finally:
        if selector is not None:
            selector.close()
        process.stdout.close()
        process.stderr.close()


def _run_helper(helper: Path, gh_args: Sequence[str]) -> str:
    node = shutil.which("node")
    if not node:
        raise CollectionError("Node.js is unavailable; no packet was produced.")
    argv = [node, str(helper), "--", *gh_args]
    try:
        return_code, stdout, _stderr = _bounded_process_output(argv)
    except CollectionError:
        raise
    except (OSError, subprocess.SubprocessError, ValueError):
        raise CollectionError("Trusted App-helper invocation failed; no packet was produced.") from None
    if return_code != 0:
        # Helper output may contain private paths or sensitive diagnostics; never relay it.
        raise CollectionError("Trusted App-helper read failed; no packet was produced.")
    return stdout.decode("utf-8", errors="replace")


def _api_read(helper: Path, endpoint: str, jq_filter: str) -> str:
    # The reviewed helper's `--` forwards these fixed read-only GET arguments to gh.
    return _run_helper(helper, ["api", endpoint, "--method", "GET", "--jq", jq_filter])


def _page_endpoint(endpoint: str, page_number: int) -> str:
    parsed = urlsplit(endpoint)
    if parsed.fragment:
        raise CollectionError("REST endpoint must not contain a fragment.")
    pagination = f"per_page={API_PAGE_SIZE}&page={page_number}"
    query = f"{parsed.query}&{pagination}" if parsed.query else pagination
    return urlunsplit(parsed._replace(query=query))


def _paginated_api_read(helper: Path, endpoint: str, collection: str) -> list[dict[str, Any]]:
    accumulated: list[dict[str, Any]] = []
    expected_total: int | None = None
    seen_ids: set[int] = set()
    for page_number in range(1, MAX_API_PAGES + 1):
        page_endpoint = _page_endpoint(endpoint, page_number)
        page = _json_object(_api_read(helper, page_endpoint, _API_FILTERS[collection]), {"total_count", collection}, collection)
        total = page["total_count"]
        rows = page[collection]
        if type(total) is not int or total < 0 or not isinstance(rows, list) or len(rows) > API_PAGE_SIZE:
            raise CollectionError(f"Invalid paginated {collection} response.")
        if expected_total is None:
            expected_total = total
        elif total != expected_total:
            raise CollectionError(f"Paginated {collection} total changed during collection.")
        if len(accumulated) + len(rows) > total:
            raise CollectionError(f"Paginated {collection} exceeded its reported total.")
        for row in rows:
            if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] <= 0:
                raise CollectionError(f"Paginated {collection} contains an invalid record.")
            if row["id"] in seen_ids:
                raise CollectionError(f"Paginated {collection} contains duplicate records.")
            seen_ids.add(row["id"])
        accumulated.extend(rows)
        if len(accumulated) == expected_total:
            return accumulated
        if len(accumulated) > expected_total or not rows or len(rows) < API_PAGE_SIZE:
            raise CollectionError(f"Paginated {collection} ended before the reported total.")
    raise CollectionError(f"Paginated {collection} exceeded the page limit; no packet was produced.")


def _read_pr(helper: Path, request: CollectionRequest) -> dict[str, Any]:
    args = [
        "pr", "view", str(request.pull_request_number), "--repo", request.repository,
        "--json", "number,baseRefOid,headRefOid,url",
    ]
    pr = _json_object(_run_helper(helper, args), {"number", "baseRefOid", "headRefOid", "url"}, "pull request")
    expected_url = f"/{request.repository}/pull/{request.pull_request_number}"
    if (
        pr["number"] != request.pull_request_number
        or pr["baseRefOid"] != request.base_sha
        or pr["headRefOid"] != request.head_sha
    ):
        raise CollectionError("Pull request identity or expected base/head SHA mismatch.")
    pr["url"] = _repository_url(pr["url"], expected_url)
    return pr


def _read_run(helper: Path, request: CollectionRequest) -> tuple[dict[str, Any], int]:
    endpoint = f"repos/{request.repository}/actions/runs/{request.run_id}"
    run = _json_object(
        _api_read(helper, endpoint, _RUN_FILTER),
        {"id", "workflow_id", "check_suite_id", "name", "event", "conclusion", "created_at", "updated_at", "html_url", "head_sha", "pull_requests"},
        "workflow run",
    )
    run_url = _repository_url(run["html_url"], f"/{request.repository}/actions/runs/{request.run_id}")
    if (
        run["id"] != request.run_id or run["head_sha"] != request.head_sha
        or run["name"] != request.workflow or run["event"] != request.event
        or run["conclusion"] != "success"
        or type(run["check_suite_id"]) is not int or run["check_suite_id"] <= 0
        or type(run["workflow_id"]) is not int or run["workflow_id"] <= 0
    ):
        raise CollectionError("Workflow run ID, revision, workflow, event, or conclusion mismatch.")
    associations = run["pull_requests"]
    if not isinstance(associations, list):
        raise CollectionError("Workflow run has invalid pull request association data.")
    matched_associations = [
        association for association in associations
        if isinstance(association, dict) and association.get("number") == request.pull_request_number
    ]
    if len(matched_associations) != 1:
        raise CollectionError("Workflow run is not uniquely associated with the requested pull request.")
    association = matched_associations[0]
    if association.get("base_sha") != request.base_sha or association.get("head_sha") != request.head_sha:
        raise CollectionError("Workflow run pull request base/head does not match the expected revision.")
    normalized_run = {
        "id": run["id"],
        "workflow_id": run["workflow_id"],
        "check_suite_id": run["check_suite_id"],
        "pull_request_number": request.pull_request_number,
        "base_sha": association["base_sha"],
        "head_sha": run["head_sha"],
        "workflow": run["name"],
        "event": run["event"],
        "conclusion": "success",
        "created_at": _safe_timestamp(run["created_at"]),
        "updated_at": _safe_timestamp(run["updated_at"]),
        "url": run_url,
    }
    return normalized_run, run["check_suite_id"]


def _read_jobs(helper: Path, request: CollectionRequest) -> list[dict[str, Any]]:
    endpoint = f"repos/{request.repository}/actions/runs/{request.run_id}/jobs"
    job_rows = _paginated_api_read(helper, endpoint, "jobs")
    if not job_rows:
        raise CollectionError("Workflow run has no job evidence.")
    jobs_by_name: dict[str, dict[str, Any]] = {}
    for source in job_rows:
        job = _object(source, {"id", "name", "conclusion", "started_at", "completed_at", "html_url"}, "job")
        name = job["name"]
        if (
            not isinstance(name, str) or not name or name in jobs_by_name
            or job["conclusion"] != "success"
        ):
            raise CollectionError("Workflow run contains duplicate, missing, or non-success jobs.")
        job_url = _repository_url(
            job["html_url"], f"/{request.repository}/actions/runs/{request.run_id}/job/{job['id']}"
        )
        jobs_by_name[name] = {
            "name": name,
            "conclusion": "success",
            "started_at": _safe_timestamp(job["started_at"]),
            "completed_at": _safe_timestamp(job["completed_at"]),
            "url": job_url,
        }
    missing_jobs = set(request.required_jobs) - jobs_by_name.keys()
    if missing_jobs:
        raise CollectionError("Required workflow job evidence is missing.")
    selected_jobs = [jobs_by_name[name] for name in request.required_jobs]
    return selected_jobs


def _read_checks(helper: Path, request: CollectionRequest, check_suite_id: int) -> list[dict[str, Any]]:
    # The run's exact suite avoids the commit-ref endpoint's recent-suite cap.
    # Check-run head_sha is still verified from each returned REST record.
    endpoint = f"repos/{request.repository}/check-suites/{check_suite_id}/check-runs?filter=all"
    rows = _paginated_api_read(helper, endpoint, "check_runs")
    if not rows:
        raise CollectionError("Commit has no check-run evidence.")
    selected: dict[str, dict[str, Any]] = {}
    for source in rows:
        row = _object(source, {"id", "name", "head_sha", "conclusion", "check_suite", "started_at", "completed_at", "html_url"}, "check run")
        suite = _object(row["check_suite"], {"id"}, "check suite")
        if suite["id"] != check_suite_id:
            continue
        if row["name"] not in request.required_checks:
            continue
        name = row["name"]
        if not isinstance(name, str) or name in selected:
            raise CollectionError("Required check-run evidence is ambiguous.")
        if row["head_sha"] != request.head_sha:
            raise CollectionError("Required check-run head SHA does not match the expected revision.")
        if row["conclusion"] != "success":
            raise CollectionError("Required check-run did not conclude successfully.")
        selected[name] = {
            "id": row["id"],
            "check_suite_id": suite["id"],
            "name": name,
            "conclusion": row["conclusion"],
            "evaluated_sha": row["head_sha"],
            "started_at": _safe_timestamp(row["started_at"]),
            "completed_at": _safe_timestamp(row["completed_at"]),
            "url": row["html_url"],
        }
    if set(selected) != set(request.required_checks):
        raise CollectionError("Required check-run evidence is missing.")
    return [selected[name] for name in request.required_checks]


def collect_packet(request: CollectionRequest) -> dict[str, Any]:
    """Read and cross-check an explicit PR/run through the reviewed App helper."""
    helper = _validate_request(request)
    first_pr = _read_pr(helper, request)
    run, check_suite_id = _read_run(helper, request)
    jobs = _read_jobs(helper, request)
    checks = _read_checks(helper, request, check_suite_id)
    last_pr = _read_pr(helper, request)
    if first_pr != last_pr:
        raise CollectionError("Pull request changed during collection; no packet was produced.")
    payload = {
        "schema_version": 1,
        "repository": request.repository,
        "pull_request_number": request.pull_request_number,
        "pull_request_url": first_pr["url"],
        "base_sha": request.base_sha,
        "head_sha": request.head_sha,
        "run": run,
        "jobs": jobs,
        "checks": checks,
        "provenance": {
            "retrieved_by": "coordinator",
            "method": "reviewed-github-app",
            # The call window's end is a coordinator timestamp, not GitHub server time.
            "retrieved_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
    }
    packet = create_packet(payload)
    expected = {
        "repository": request.repository,
        "pull_request_number": request.pull_request_number,
        "pull_request_url": first_pr["url"],
        "base_sha": request.base_sha,
        "head_sha": request.head_sha,
        "run_id": request.run_id,
        "workflow": request.workflow,
        "event": request.event,
        "required_jobs": request.required_jobs,
        "required_checks": request.required_checks,
    }
    validate_packet(packet, expected)
    # Exercise the exact output serializer before allowing the caller to print anything.
    serialize_packet(packet)
    return packet


def _parser() -> argparse.ArgumentParser:
    parser = SanitizedArgumentParser(description="Coordinator-only read-only CI evidence collection via trusted gh-app.mjs")
    parser.add_argument("--helper-path", required=True, help="absolute path to a previously reviewed trusted gh-app.mjs")
    parser.add_argument("--repo", required=True, help="must be grasdouble/Jarvis")
    parser.add_argument("--pr", required=True, type=int, help="pull request number")
    parser.add_argument("--base-sha", required=True, help="expected full base SHA")
    parser.add_argument("--head-sha", required=True, help="expected full head SHA")
    parser.add_argument("--run-id", required=True, type=int, help="workflow run ID")
    parser.add_argument("--workflow", required=True, help="exact expected Actions workflow name")
    parser.add_argument("--event", required=True, help="exact expected workflow event")
    parser.add_argument("--required-job", action="append", required=True, help="required run job name; repeat as needed")
    parser.add_argument("--required-check", action="append", required=True, help="required check-run name; repeat as needed")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    request = CollectionRequest(
        helper_path=args.helper_path,
        repository=args.repo,
        pull_request_number=args.pr,
        base_sha=args.base_sha,
        head_sha=args.head_sha,
        run_id=args.run_id,
        workflow=args.workflow,
        event=args.event,
        required_jobs=tuple(args.required_job),
        required_checks=tuple(args.required_check),
    )
    try:
        packet = collect_packet(request)
        output = serialize_packet(packet)
    except Exception:
        print("CI evidence collection failed; no packet was produced.", file=sys.stderr)
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
