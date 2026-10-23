import contextlib
import io
import json
import os
from pathlib import Path
import signal
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

from ci_evidence_packet import validate_packet
from collect_ci_evidence import (
    CollectionError,
    CollectionRequest,
    _clean_helper_environment,
    _paginated_api_read,
    collect_packet,
    main,
)


BASE = "a" * 40
HEAD = "b" * 40
RUN_ID = 987654321
PR_NUMBER = 213
WORKFLOW = "Repository checks"
JOB_NAME = "Repository configuration"
CHECK_NAME = "Repository configuration"
JOB_URL = f"https://github.com/grasdouble/Jarvis/actions/runs/{RUN_ID}/job/123"


def pr_response(**overrides):
    response = {
        "number": PR_NUMBER,
        "baseRefOid": BASE,
        "headRefOid": HEAD,
        "url": f"https://github.com/grasdouble/Jarvis/pull/{PR_NUMBER}",
        "title": "ignored allowlist field",
    }
    response.update(overrides)
    return response


def run_response(**overrides):
    response = {
        "id": RUN_ID,
        "workflow_id": 19,
        "check_suite_id": 222,
        "name": WORKFLOW,
        "event": "pull_request",
        "conclusion": "success",
        "created_at": "2026-10-23T10:00:00Z",
        "updated_at": "2026-10-23T10:05:00Z",
        "html_url": f"https://github.com/grasdouble/Jarvis/actions/runs/{RUN_ID}",
        "head_sha": HEAD,
        "pull_requests": [{"number": PR_NUMBER, "base_sha": BASE, "head_sha": HEAD}],
    }
    response.update(overrides)
    return response


def jobs_page(jobs=None, total_count=None):
    rows = jobs if jobs is not None else [{
            "id": 123,
            "name": JOB_NAME,
            "conclusion": "success",
            "started_at": "2026-10-23T10:00:10Z",
            "completed_at": "2026-10-23T10:04:00Z",
            "html_url": JOB_URL,
            "steps": [{"name": "unretained"}],
        }]
    return {"total_count": len(rows) if total_count is None else total_count, "jobs": rows}


def check_run(name=CHECK_NAME, suite_id=222, head_sha=HEAD, conclusion="success", **overrides):
    result = {
        "id": 456,
        "name": name,
        "head_sha": head_sha,
        "conclusion": conclusion,
        "check_suite": {"id": suite_id},
        "started_at": "2026-10-23T10:00:10Z",
        "completed_at": "2026-10-23T10:04:00Z",
        "html_url": JOB_URL,
        "output": {"title": "unretained"},
    }
    result.update(overrides)
    return result


def checks_page(checks=None, total_count=None):
    rows = checks if checks is not None else [check_run()]
    return {"total_count": len(rows) if total_count is None else total_count, "check_runs": rows}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.helper = Path(self.directory.name) / "gh-app.mjs"
        # Only a path fixture: every subprocess call is mocked.
        self.helper.write_text("// fixture; never executed\n")
        self.request = CollectionRequest(
            helper_path=str(self.helper),
            repository="grasdouble/Jarvis",
            pull_request_number=PR_NUMBER,
            base_sha=BASE,
            head_sha=HEAD,
            run_id=RUN_ID,
            workflow=WORKFLOW,
            event="pull_request",
            required_jobs=(JOB_NAME,),
            required_checks=(CHECK_NAME,),
        )

    @staticmethod
    def successful_responses():
        return [
            pr_response(),
            run_response(),
            jobs_page(),
            checks_page(),
            pr_response(),
        ]

    def patch_helper(self, responses):
        queue = iter(responses)

        def run(helper, gh_args):
            self.assertEqual(helper, self.helper)
            self.assertIsInstance(gh_args, list)
            next_response = next(queue)
            if isinstance(next_response, tuple):
                if next_response[0] != 0:
                    raise CollectionError("Trusted App-helper read failed; no packet was produced.")
                return next_response[1]
            return json.dumps(next_response)

        return patch("collect_ci_evidence._run_helper", side_effect=run)

    def test_success_uses_read_only_app_requests_and_emits_allowlisted_packet(self):
        responses = self.successful_responses()
        with patch.dict(os.environ, {"GH_TOKEN": "ambient-gh-secret", "FORGEJO_TOKEN": "other-secret"}):
            environment = _clean_helper_environment()
            self.assertNotIn("GH_TOKEN", environment)
            self.assertNotIn("FORGEJO_TOKEN", environment)
            self.assertLessEqual(set(environment), {"PATH", "HOME", "TMPDIR", "JARVIS_GITHUB_APP_KEY_FILE"})
            with patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
                with self.patch_helper(responses) as runner:
                    packet = collect_packet(self.request)

        self.assertEqual(runner.call_count, 5)
        calls = [call.args[1] for call in runner.call_args_list]
        self.assertEqual(calls[0][:2], ["pr", "view"])
        self.assertEqual(calls[0][2:5], [str(PR_NUMBER), "--repo", "grasdouble/Jarvis"])
        self.assertIn("number,baseRefOid,headRefOid,url", calls[0])
        self.assertEqual(calls[1][:2], ["api", f"repos/grasdouble/Jarvis/actions/runs/{RUN_ID}"])
        self.assertIn("--method", calls[1])
        self.assertIn("--jq", calls[1])
        self.assertIn("pull_requests", calls[1][calls[1].index("--jq") + 1])
        self.assertEqual(calls[2][:2], ["api", f"repos/grasdouble/Jarvis/actions/runs/{RUN_ID}/jobs?per_page=100&page=1"])
        self.assertEqual(calls[3][:2], ["api", f"repos/grasdouble/Jarvis/check-suites/222/check-runs?filter=all&per_page=100&page=1"])
        self.assertIn("--method", calls[3])
        self.assertIn("--jq", calls[3])
        self.assertEqual(calls[4], calls[0])
        for call in runner.call_args_list:
            self.assertNotIn("--write", call.args[1])
        expected = {
            "repository": "grasdouble/Jarvis",
            "pull_request_number": PR_NUMBER,
            "pull_request_url": f"https://github.com/grasdouble/Jarvis/pull/{PR_NUMBER}",
            "base_sha": BASE,
            "head_sha": HEAD,
            "run_id": RUN_ID,
            "workflow": WORKFLOW,
            "event": "pull_request",
            "required_jobs": [JOB_NAME],
            "required_checks": [CHECK_NAME],
        }
        validate_packet(packet, expected)
        self.assertEqual(set(packet), {
            "schema_version", "repository", "pull_request_number", "pull_request_url", "base_sha", "head_sha",
            "run", "jobs", "checks", "provenance", "integrity_sha256",
        })
        self.assertEqual(packet["jobs"][0]["name"], JOB_NAME)
        self.assertEqual(packet["checks"][0]["evaluated_sha"], HEAD)
        self.assertEqual(packet["checks"][0]["check_suite_id"], packet["run"]["check_suite_id"])
        self.assertEqual(packet["provenance"]["retrieved_by"], "coordinator")
        self.assertEqual(packet["provenance"]["method"], "reviewed-github-app")

    def test_successful_cli_prints_only_sanitized_packet_json(self):
        argv = [
            "--helper-path", str(self.helper), "--repo", "grasdouble/Jarvis", "--pr", str(PR_NUMBER),
            "--base-sha", BASE, "--head-sha", HEAD, "--run-id", str(RUN_ID),
            "--workflow", WORKFLOW, "--event", "pull_request", "--required-job", JOB_NAME,
            "--required-check", CHECK_NAME,
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
            with self.patch_helper(self.successful_responses()):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    result = main(argv)
        self.assertEqual(result, 0)
        self.assertEqual(stderr.getvalue(), "")
        packet = json.loads(stdout.getvalue())
        self.assertEqual(packet["pull_request_number"], PR_NUMBER)
        self.assertNotIn("steps", stdout.getvalue())
        self.assertNotIn("unretained", stdout.getvalue())

    def test_jobs_and_check_runs_are_explicitly_paginated_to_the_reported_total(self):
        first_jobs = [
            {
                "id": 1000 + i,
                "name": f"Auxiliary job {i}",
                "conclusion": "success",
                "started_at": "2026-10-23T10:00:10Z",
                "completed_at": "2026-10-23T10:04:00Z",
                "html_url": f"https://github.com/grasdouble/Jarvis/actions/runs/{RUN_ID}/job/{1000 + i}",
            }
            for i in range(100)
        ]
        first_checks = [check_run(id=2000 + i, name=f"Auxiliary check {i}", suite_id=999) for i in range(100)]
        responses = [
            pr_response(), run_response(),
            jobs_page(first_jobs, total_count=101), jobs_page(total_count=101),
            checks_page(first_checks, total_count=101), checks_page(total_count=101),
            pr_response(),
        ]
        # The required job and check occur on page two; the check's suite and head are observed fields.
        responses[3] = jobs_page([{
            "id": 123, "name": JOB_NAME, "conclusion": "success",
            "started_at": "2026-10-23T10:00:10Z", "completed_at": "2026-10-23T10:04:00Z",
            "html_url": JOB_URL,
        }], total_count=101)
        responses[5] = checks_page([check_run(id=456)], total_count=101)

        with patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
            with self.patch_helper(responses) as runner:
                packet = collect_packet(self.request)
        endpoints = [call.args[1][1] for call in runner.call_args_list]
        self.assertEqual(endpoints[2:6], [
            f"repos/grasdouble/Jarvis/actions/runs/{RUN_ID}/jobs?per_page=100&page=1",
            f"repos/grasdouble/Jarvis/actions/runs/{RUN_ID}/jobs?per_page=100&page=2",
            f"repos/grasdouble/Jarvis/check-suites/222/check-runs?filter=all&per_page=100&page=1",
            f"repos/grasdouble/Jarvis/check-suites/222/check-runs?filter=all&per_page=100&page=2",
        ])
        self.assertEqual(packet["checks"][0]["evaluated_sha"], HEAD)

    def test_first_check_suite_page_composes_filter_and_pagination_query_exactly(self):
        endpoint = "repos/grasdouble/Jarvis/check-suites/222/check-runs?filter=all"
        expected = "repos/grasdouble/Jarvis/check-suites/222/check-runs?filter=all&per_page=100&page=1"
        with patch("collect_ci_evidence._api_read", return_value=json.dumps({"total_count": 0, "check_runs": []})) as api_read:
            result = _paginated_api_read(self.helper, endpoint, "check_runs")
        self.assertEqual(result, [])
        self.assertEqual(api_read.call_args.args[1], expected)
        self.assertNotIn("?filter=all?", api_read.call_args.args[1])

    def test_incomplete_pagination_and_duplicate_job_identity_fail_closed(self):
        incomplete_job_page = jobs_page([jobs_page()["jobs"][0]], total_count=101)
        duplicate_jobs = jobs_page([
            jobs_page()["jobs"][0],
            dict(jobs_page()["jobs"][0], id=124),
        ], total_count=2)
        cases = [
            [pr_response(), run_response(), jobs_page([dict(jobs_page()["jobs"][0], name="Other job")])],
            [pr_response(), run_response(), jobs_page([], total_count=0)],
            [pr_response(), run_response(), incomplete_job_page],
            [pr_response(), run_response(), duplicate_jobs],
            [pr_response(), run_response(), jobs_page(), checks_page([], total_count=0)],
        ]
        for responses in cases:
            with self.subTest(responses=responses), patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
                with self.patch_helper(responses), self.assertRaises(CollectionError):
                    collect_packet(self.request)

    def test_pagination_stops_at_documented_page_limit_instead_of_truncating(self):
        pages = []
        for page_number in range(20):
            pages.append({
                "total_count": 2001,
                "jobs": [{"id": page_number * 100 + index + 1} for index in range(100)],
            })
        with patch("collect_ci_evidence._api_read", side_effect=[json.dumps(page) for page in pages]) as api_read:
            with self.assertRaisesRegex(CollectionError, "page limit"):
                _paginated_api_read(self.helper, "repos/grasdouble/Jarvis/test", "jobs")
        self.assertEqual(api_read.call_count, 20)

    def test_wrong_pr_base_head_or_pr_race_fails_without_packet(self):
        cases = [
            [{}],
            [pr_response(number=PR_NUMBER + 1)],
            [pr_response(baseRefOid=HEAD)],
            [pr_response(headRefOid=BASE)],
            [pr_response(), run_response(), jobs_page(), checks_page(), pr_response(headRefOid=BASE)],
        ]
        for responses in cases:
            with self.subTest(response=responses), patch("collect_ci_evidence.shutil.which", return_value="node"):
                with self.patch_helper(responses), self.assertRaises(CollectionError):
                    collect_packet(self.request)

    def test_wrong_or_missing_run_identity_and_required_job_fail_closed(self):
        cases = [
            [pr_response(), {}],
            run_response(id=RUN_ID + 1),
            run_response(head_sha=BASE),
            run_response(name="Other workflow"),
            run_response(event="push"),
            run_response(conclusion="failure"),
            run_response(check_suite_id=None),
            run_response(pull_requests=[]),
            run_response(pull_requests=[{"number": PR_NUMBER + 1, "base_sha": BASE, "head_sha": HEAD}]),
            run_response(pull_requests=[{"number": PR_NUMBER, "base_sha": HEAD, "head_sha": HEAD}]),
        ]
        for response in cases:
            with self.subTest(run=response), patch("collect_ci_evidence.shutil.which", return_value="node"):
                with self.patch_helper([pr_response(), response]), self.assertRaises(CollectionError):
                    collect_packet(self.request)

    def test_missing_wrong_or_failed_required_check_fails_closed(self):
        cases = [
            [],
            checks_page([check_run(name="Other check")]),
            checks_page([check_run(suite_id=999)]),
            checks_page([check_run(head_sha=BASE)]),
            checks_page([check_run(conclusion="failure")]),
            checks_page([check_run(conclusion="skipped")]),
            checks_page([check_run(id=456), check_run(id=457)]),
        ]
        for response in cases:
            with self.subTest(checks=response), patch("collect_ci_evidence.shutil.which", return_value="node"):
                with self.patch_helper([pr_response(), run_response(), jobs_page(), response]), self.assertRaises(CollectionError):
                    collect_packet(self.request)

    def test_nonzero_helper_and_malformed_json_emit_no_secret_output_or_packet(self):
        secret = "ghp_" + "X" * 40
        scenarios = [
            [(1, f"private {secret}", f"Bearer {secret}")],
            [(0, f"not-json {secret}", f"token={secret}")],
            [pr_response(), (1, f"private {secret}", f"Bearer {secret}")],
        ]
        for response in scenarios:
            stdout, stderr = io.StringIO(), io.StringIO()
            argv = [
                "--helper-path", str(self.helper), "--repo", "grasdouble/Jarvis", "--pr", str(PR_NUMBER),
                "--base-sha", BASE, "--head-sha", HEAD, "--run-id", str(RUN_ID),
                "--workflow", WORKFLOW, "--event", "pull_request", "--required-job", JOB_NAME,
                "--required-check", CHECK_NAME,
            ]
            with patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
                with self.patch_helper(response):
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        result = main(argv)
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("no packet was produced", stderr.getvalue())
            self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())

    def test_identity_and_duplicate_json_failures_exit_nonzero_without_packet(self):
        scenarios = [[(0, json.dumps(pr_response(number=PR_NUMBER + 1)), "")], [(0, '{"number":213,"number":213}', "")]]
        for response in scenarios:
            stdout, stderr = io.StringIO(), io.StringIO()
            argv = [
                "--helper-path", str(self.helper), "--repo", "grasdouble/Jarvis", "--pr", str(PR_NUMBER),
                "--base-sha", BASE, "--head-sha", HEAD, "--run-id", str(RUN_ID),
                "--workflow", WORKFLOW, "--event", "pull_request", "--required-job", JOB_NAME,
                "--required-check", CHECK_NAME,
            ]
            with patch("collect_ci_evidence.shutil.which", return_value="/usr/bin/node"):
                with self.patch_helper(response):
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        result = main(argv)
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("no packet was produced", stderr.getvalue())

    def test_invalid_helper_or_required_policy_rejected_before_subprocess(self):
        invalid = [
            CollectionRequest(**{**self.request.__dict__, "helper_path": "relative/gh-app.mjs"}),
            CollectionRequest(**{
                **self.request.__dict__,
                "helper_path": str(Path(__file__).resolve().parents[2] / "jarvis-backlog/scripts/github/gh-app.mjs"),
            }),
            CollectionRequest(**{**self.request.__dict__, "repository": "other/repo"}),
            CollectionRequest(**{**self.request.__dict__, "required_jobs": ()}),
            CollectionRequest(**{**self.request.__dict__, "required_checks": ()}),
        ]
        with patch("collect_ci_evidence._run_helper") as runner:
            for request in invalid:
                with self.subTest(request=request), self.assertRaises(CollectionError):
                    collect_packet(request)
        runner.assert_not_called()

    def test_argument_errors_do_not_echo_sensitive_argument_values(self):
        secret = "ghp_" + "Z" * 40
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as error:
                main(["--helper-path", str(self.helper), "--repo", "grasdouble/Jarvis", "--pr", secret])
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(secret, stderr.getvalue())
        self.assertIn("Invalid collector arguments", stderr.getvalue())

    def test_stdout_and_stderr_overflow_stops_synthetic_child_process_tree(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required for the harmless process-tree cap test")
        secret = "CAP_TEST_SECRET_"
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                with tempfile.TemporaryDirectory(prefix=".cap-process-", dir=Path(__file__).parent) as folder:
                    folder_path = Path(folder)
                    child_file = folder_path / "child.mjs"
                    helper_file = folder_path / "gh-app.mjs"
                    pid_file = folder_path / "child.pid"
                    child_file.write_text(
                        "process.on('SIGTERM', () => {});\n"
                        "setInterval(() => {}, 1000);\n"
                    )
                    helper_file.write_text(
                        "import {spawn} from 'node:child_process';\n"
                        "import {writeFileSync} from 'node:fs';\n"
                        f"const child = spawn(process.execPath, [{json.dumps(str(child_file))}], {{stdio:'ignore'}});\n"
                        f"writeFileSync({json.dumps(str(pid_file))}, String(child.pid));\n"
                        f"const target = {json.dumps(stream)} === 'stdout' ? process.stdout : process.stderr;\n"
                        f"target.write('{secret}' + 'x'.repeat(3 * 1024 * 1024));\n"
                    )
                    child_pid = None
                    try:
                        argv = [
                            "--helper-path", str(helper_file), "--repo", "grasdouble/Jarvis",
                            "--pr", str(PR_NUMBER), "--base-sha", BASE, "--head-sha", HEAD,
                            "--run-id", str(RUN_ID), "--workflow", WORKFLOW,
                            "--event", "pull_request", "--required-job", JOB_NAME,
                            "--required-check", CHECK_NAME,
                        ]
                        stdout, stderr = io.StringIO(), io.StringIO()
                        # Bypass only the trusted-path check for this temporary harmless
                        # helper; all process execution and bounded collection stays real.
                        with patch("collect_ci_evidence._validate_request", return_value=helper_file):
                            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                                result = main(argv)
                        self.assertEqual(result, 2)
                        self.assertEqual(stdout.getvalue(), "")
                        self.assertIn("no packet was produced", stderr.getvalue())
                        self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
                        self.assertTrue(pid_file.is_file(), "synthetic child did not start")
                        child_pid = int(pid_file.read_text())
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            try:
                                os.kill(child_pid, 0)
                            except ProcessLookupError:
                                break
                            time.sleep(0.05)
                        else:
                            self.fail("overflow left a spawned child process alive")
                    finally:
                        if child_pid is None and pid_file.is_file():
                            child_pid = int(pid_file.read_text())
                        if child_pid is not None:
                            try:
                                os.kill(child_pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass


if __name__ == "__main__":
    unittest.main()
