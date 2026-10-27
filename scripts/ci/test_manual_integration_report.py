import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import manual_integration_report as report


class ManualIntegrationReportTests(unittest.TestCase):
    def test_actual_node_tap_output_is_parsed_with_scenarios(self):
        # Captured from pnpm --filter @jarvis/persistence test on this checkout.
        tap = '''✔ PostgresOwnerAuthStore is exported and maps the single owner credential (41.810041ms)
▶ PostgreSQL persistence integration
  ✔ cleanup records every phase failure and continues later phases (2.140291ms)
  ﹣ PostgreSQL migrations and checkpoint authorization work against the real database (0.214375ms) # set JARVIS_TEST_DATABASE_URL to a disposable empty database
✔ PostgreSQL persistence integration (5.333417ms)
ℹ tests 35
ℹ suites 1
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
'''
        totals, scenarios = report.parse_tap(tap)
        self.assertEqual(totals['tests'], 35)
        self.assertEqual(totals['skipped'], 1)
        self.assertEqual(scenarios[0]['status'], 'pass')
        self.assertTrue(any(item['status'] == 'skip' for item in scenarios))

    def test_missing_or_zero_test_summaries_fail_closed(self):
        for tap in ('no TAP summary', '# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0'):
            with self.subTest(tap=tap):
                with self.assertRaises(ValueError):
                    report.parse_tap(tap)

    def test_event_context_validation_preserves_pr_context_and_rejects_bad_values(self):
        data = report.candidate_from_values('pull_request', 'refs/pull/17/merge', 'a' * 40,
                                            '17', 'b' * 40, 'a' * 40)
        self.assertEqual(data, {'event': 'pull_request', 'ref': 'refs/pull/17/merge', 'sha': 'a' * 40,
                                'pr': 17, 'base': 'b' * 40, 'head': 'a' * 40})
        self.assertEqual(report.candidate_from_values('workflow_dispatch', 'refs/heads/feature/test', 'c' * 40),
                         {'event': 'workflow_dispatch', 'ref': 'refs/heads/feature/test', 'sha': 'c' * 40})
        self.assertEqual(report.candidate_from_values('push', 'refs/heads/main', 'd' * 40),
                         {'event': 'push', 'ref': 'refs/heads/main', 'sha': 'd' * 40})
        for args in [('push', 'refs/heads/main', 'A' * 40),
                     ('push', 'refs/heads/../main', 'a' * 40),
                     ('push', 'refs/tags/v1', 'a' * 40),
                     ('workflow_dispatch', 'refs/tags/release', 'a' * 40),
                     ('pull_request', 'refs/pull/17/merge', 'a' * 40, '', 'b' * 40, 'a' * 40),
                     ('pull_request', 'refs/pull/18/merge', 'a' * 40, '17', 'b' * 40, 'a' * 40),
                     ('pull_request', 'refs/pull/17/merge', 'c' * 40, '17', 'b' * 40, 'a' * 40),
                     ('workflow_dispatch', 'refs/heads/main', 'a' * 40, '17', 'b' * 40, 'a' * 40)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                report.candidate_from_values(*args)

    def test_exact_required_scenario_controls_report_success(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}

        def run(tap):
            results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
            results.append(type('Result', (), {'returncode': 0, 'stdout': tap})())
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'report.json'
                with patch.object(report.subprocess, 'run', side_effect=results):
                    try:
                        report.run_report(candidate, output)
                    except SystemExit:
                        pass
                return json.loads(output.read_text())

        base = '''TAP version 13\n1..2\nok 1 - unrelated scenario\n{case}\n# tests 2\n# pass {passed}\n# fail {failed}\n# cancelled 0\n# skipped {skipped}\n# todo 0\n'''
        required = report.REQUIRED_SCENARIO
        passing = run(base.format(case=f'ok 2 - {required}', passed=2, failed=0, skipped=0))
        self.assertEqual(passing['result'], 'pass')
        self.assertEqual({key: passing[key] for key in candidate}, candidate)
        self.assertEqual(len(passing['commands']), 3)
        self.assertEqual(passing['scenarios'][1], {'status': 'pass', 'name': required})
        for case, passed, failed, skipped in (
            ('ok 2 - another scenario', 2, 0, 0),
            (f'ok 2 - {required} # SKIP database unavailable', 1, 0, 1),
            (f'not ok 2 - {required}', 1, 1, 0),
        ):
            with self.subTest(case=case):
                failed_report = run(base.format(case=case, passed=passed, failed=failed, skipped=skipped))
                self.assertEqual(failed_report['result'], 'fail')
                self.assertTrue(failed_report['required_scenario_error'])

    def test_todo_and_cancelled_tests_fail_closed(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        for counter, value in (('todo', 1), ('cancelled', 1)):
            with self.subTest(counter=counter):
                tap = (f'TAP version 13\n1..2\nok 1 - unrelated scenario\n'
                       f'ok 2 - {report.REQUIRED_SCENARIO}\n# tests 2\n# pass 2\n'
                       f'# fail 0\n# cancelled {value if counter == "cancelled" else 0}\n'
                       f'# skipped 0\n# todo {value if counter == "todo" else 0}\n')
                results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
                results.append(type('Result', (), {'returncode': 0, 'stdout': tap})())
                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / 'report.json'
                    with patch.object(report.subprocess, 'run', side_effect=results):
                        with self.assertRaises(SystemExit) as error:
                            report.run_report(candidate, output)
                    self.assertEqual(error.exception.code, 1)
                    saved = json.loads(output.read_text())
                    self.assertEqual(saved['result'], 'fail')
                    self.assertIn('# tests 2', saved['failure_diagnostics'])

    def test_failure_from_totals_retains_test_output_even_when_command_succeeds(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        tap = (f'ok 1 - {report.REQUIRED_SCENARIO}\nnot ok 2 - another assertion\n'
               '  error: AssertionError: expected 2\n# tests 2\n# pass 1\n# fail 1\n'
               '# cancelled 0\n# skipped 0\n# todo 0\n')
        results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
        results.append(type('Result', (), {'returncode': 0, 'stdout': tap})())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.object(report.subprocess, 'run', side_effect=results):
                with self.assertRaises(SystemExit): report.run_report(candidate, output)
            saved = json.loads(output.read_text())
        self.assertEqual(saved['commands'][-1]['exit_code'], 0)
        self.assertEqual(saved['result'], 'fail')
        self.assertIn('AssertionError: expected 2', saved['failure_diagnostics'])

    def test_setup_failure_is_reported_and_prevents_integration_commands(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        setup = [{'command': 'npm install --global pnpm@12.5.1', 'exit_code': 1,
                  'duration_seconds': 1.25, 'started_at_utc': '2026-01-01T00:00:00+00:00',
                  'ended_at_utc': '2026-01-01T00:00:01+00:00'}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.dict('os.environ', {'JARVIS_SETUP_RESULTS': json.dumps(setup)}), \
                    patch.object(report.subprocess, 'run') as execute:
                with self.assertRaises(SystemExit):
                    report.run_report(candidate, output)
            execute.assert_not_called()
            saved = json.loads(output.read_text())
            self.assertEqual(saved['setup_commands'], setup)
            self.assertEqual(saved['commands'], setup)
            self.assertEqual(saved['integration_status'], 'not_run')
            self.assertEqual(saved['result'], 'fail')

    def test_setup_success_is_accounted_before_all_integration_commands(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        setup = [{'command': 'npm install --global pnpm@12.5.1', 'exit_code': 0,
                  'duration_seconds': 1.0}, {'command': 'pnpm install --frozen-lockfile',
                  'exit_code': 0, 'duration_seconds': 2.0}]
        tap = (f'TAP version 13\n1..1\nok 1 - {report.REQUIRED_SCENARIO}\n# tests 1\n'
               '# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n')
        results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
        results.append(type('Result', (), {'returncode': 0, 'stdout': tap})())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.dict('os.environ', {'JARVIS_SETUP_RESULTS': json.dumps(setup)}), \
                    patch.object(report.subprocess, 'run', side_effect=results) as execute:
                report.run_report(candidate, output)
            saved = json.loads(output.read_text())
        self.assertEqual(execute.call_count, 3)
        self.assertEqual(saved['commands'][:2], setup)
        self.assertEqual(len(saved['commands']), 5)
        self.assertEqual(saved['integration_status'], 'run')

    def test_build_failure_is_reported_without_running_persistence_test(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        setup = [{'command': 'npm install --global pnpm@12.5.1', 'exit_code': 0,
                  'duration_seconds': 1.0}]
        build_result = type('Result', (), {'returncode': 2, 'stdout': 'build failed'})()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.dict('os.environ', {'JARVIS_SETUP_RESULTS': json.dumps(setup)}), \
                    patch.object(report.subprocess, 'run', return_value=build_result) as execute:
                with self.assertRaises(SystemExit) as error:
                    report.run_report(candidate, output)
            self.assertEqual(error.exception.code, 1)
            execute.assert_called_once()
            saved = json.loads(output.read_text())
        self.assertEqual(len(saved['commands']), 2)
        self.assertEqual(saved['commands'][-1]['exit_code'], 2)
        self.assertEqual(saved['integration_status'], 'not_run')
        self.assertEqual(saved['result'], 'fail')
        self.assertEqual(saved['exit_code'], 2)

    def test_failed_report_has_bounded_sanitized_diagnostics(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        secret = 'fake-secret-token-123'
        tap = (f'not ok 1 - {report.REQUIRED_SCENARIO}\n  error: AssertionError: expected value\n'
               f'  at test.js:12:3\n  connection postgres://user:{secret}@db.example/test\n'
               f'# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n')
        results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
        results.append(type('Result', (), {'returncode': 1, 'stdout': tap})())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.dict('os.environ', {'JARVIS_TEST_DATABASE_URL': f'postgres://u:{secret}@host/db', 'GITHUB_TOKEN': secret}), \
                    patch.object(report.subprocess, 'run', side_effect=results):
                with self.assertRaises(SystemExit): report.run_report(candidate, output)
            raw = output.read_bytes()
            saved = json.loads(raw)
        diagnostics = saved['failure_diagnostics']
        self.assertIn('AssertionError', diagnostics)
        self.assertIn('test.js:12:3', diagnostics)
        self.assertNotIn(secret, raw.decode())
        self.assertLessEqual(len(raw), 8192)
        self.assertLessEqual(len(raw.decode().splitlines()), 120)

    def test_diagnostics_truncate_deterministically_by_bytes_and_lines(self):
        first = report.bounded_diagnostics('x' * 20000 + '\n' + 'line\n' * 200)
        second = report.bounded_diagnostics('x' * 20000 + '\n' + 'line\n' * 200)
        self.assertEqual(first, second)
        self.assertLessEqual(len(first.encode()), 8192)
        self.assertLessEqual(len(first.splitlines()), 120)
        self.assertIn('truncated', first)

    def test_passing_report_omits_test_output_diagnostics(self):
        candidate = {'event': 'pull_request', 'ref': 'refs/pull/7/merge', 'sha': 'a' * 40,
                     'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
        tap = (f'ok 1 - {report.REQUIRED_SCENARIO}\n# tests 1\n# pass 1\n# fail 0\n'
               '# cancelled 0\n# skipped 0\n# todo 0\n')
        results = [type('Result', (), {'returncode': 0, 'stdout': ''})() for _ in range(2)]
        results.append(type('Result', (), {'returncode': 0, 'stdout': tap + 'SECRET TEST OUTPUT'})())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'report.json'
            with patch.object(report.subprocess, 'run', side_effect=results): report.run_report(candidate, output)
            saved = json.loads(output.read_text())
            serialized = output.read_text()
            self.assertNotIn('failure_diagnostics', saved)
            self.assertNotIn('SECRET TEST OUTPUT', serialized)


if __name__ == '__main__':
    unittest.main()
