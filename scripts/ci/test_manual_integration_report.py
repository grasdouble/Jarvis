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

    def test_metadata_rejects_invalid_pr_and_sha_before_network(self):
        for pr, sha in [('0', 'a' * 40), ('7;id', 'a' * 40), ('7', 'A' * 40)]:
            with self.subTest(pr=pr, sha=sha), patch.object(report, 'urlopen') as request:
                with self.assertRaises(ValueError):
                    report.metadata(pr, sha, 'token')
                request.assert_not_called()

    def test_metadata_requires_open_matching_head(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self): return json.dumps({'state': 'open', 'head': {'sha': 'b' * 40},
                                               'base': {'sha': 'c' * 40}}).encode()

        with patch.dict('os.environ', {'GITHUB_REPOSITORY': 'owner/repo'}), \
                patch.object(report, 'urlopen', return_value=Response()):
            with self.assertRaises(ValueError):
                report.metadata('7', 'a' * 40, 'token')

    def test_validated_metadata_is_emitted_as_explicit_outputs_and_bound_to_report(self):
        data = {'pr': 17, 'base': 'b' * 40, 'head': 'a' * 40}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'github-output'
            report.write_github_output(output, data)
            self.assertEqual(output.read_text(), f'pr=17\nbase={"b" * 40}\nhead={"a" * 40}\n')
        self.assertEqual(report.candidate_from_values('17', 'b' * 40, 'a' * 40), data)
        with self.assertRaises(ValueError):
            report.candidate_from_values('17', '../bad', 'a' * 40)

    def test_exact_required_scenario_controls_report_success(self):
        candidate = {'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}

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
        self.assertEqual({key: passing[key] for key in ('pr', 'base', 'head')}, candidate)
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
        candidate = {'pr': 7, 'base': 'b' * 40, 'head': 'a' * 40}
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
                    self.assertEqual(json.loads(output.read_text())['result'], 'fail')


if __name__ == '__main__':
    unittest.main()
