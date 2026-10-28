"""Exercise malformed and unsafe inputs to the repository configuration check."""

from copy import deepcopy
from pathlib import Path
import shlex
import re
import tempfile
import unittest

from check_repository import check_markdown, check_workflow, load_yaml, load_yaml_documents


class RepositoryChecksTest(unittest.TestCase):
    def valid_workflow(self):
        return load_yaml('''
on: pull_request
permissions: {contents: read}
jobs:
  check:
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
        with: {persist-credentials: false}
''')

    def test_workflow_on_and_boolean_are_preserved(self):
        workflow = self.valid_workflow()
        self.assertIn('on', workflow)
        check_workflow(workflow)

    def test_duplicate_yaml_key_is_rejected(self):
        with self.assertRaises(ValueError):
            load_yaml('permissions: read\npermissions: write\n')

    def test_yaml_document_stream_is_loaded_with_strict_mappings(self):
        documents = load_yaml_documents('''
packageManagerDependencies:
  pnpm: 12.5.1
---
lockfileVersion: '9.0'
''')
        self.assertEqual(documents, [
            {'packageManagerDependencies': {'pnpm': '12.5.1'}},
            {'lockfileVersion': '9.0'},
        ])

    def test_duplicate_key_is_rejected_in_yaml_document_stream(self):
        with self.assertRaises(ValueError):
            load_yaml_documents('''
first: document
---
key: first
key: duplicate
''')

    def test_tagged_action_is_rejected(self):
        workflow = self.valid_workflow()
        workflow['jobs']['check']['steps'][0]['uses'] = 'actions/checkout@v6'
        with self.assertRaises(ValueError):
            check_workflow(workflow)

    def test_persisted_credentials_are_rejected(self):
        workflow = self.valid_workflow()
        workflow['jobs']['check']['steps'][0]['with']['persist-credentials'] = True
        with self.assertRaises(ValueError):
            check_workflow(workflow)

    def test_default_write_permissions_are_rejected(self):
        for permissions in ({'contents': 'write'}, {'contents': 'read', 'actions': 'write'},
                            {'contents': 'read', 'administration': 'admin'}):
            with self.subTest(permissions=permissions):
                workflow = self.valid_workflow()
                workflow['permissions'] = permissions
                with self.assertRaises(ValueError):
                    check_workflow(workflow)

    def test_explicit_read_only_permissions_are_accepted(self):
        for permissions in ({'contents': 'read'}, {'contents': 'read', 'pull-requests': 'read'}):
            with self.subTest(permissions=permissions):
                workflow = self.valid_workflow()
                workflow['permissions'] = permissions
                check_workflow(workflow)

    def test_unrelated_read_permissions_are_rejected(self):
        for permissions in ({'contents': 'read', 'issues': 'read'},
                            {'contents': 'read', 'actions': 'read'},
                            {'pull-requests': 'read'}, {'contents': 'none'}):
            with self.subTest(permissions=permissions):
                workflow = self.valid_workflow()
                workflow['permissions'] = permissions
                with self.assertRaises(ValueError):
                    check_workflow(workflow)

    def test_missing_timeout_is_rejected(self):
        workflow = deepcopy(self.valid_workflow())
        del workflow['jobs']['check']['timeout-minutes']
        with self.assertRaises(ValueError):
            check_workflow(workflow)

    def test_changeset_action_is_pinned_and_missing_coverage_fails_the_job(self):
        root = Path(__file__).resolve().parents[2]
        workflow = load_yaml((root / '.github/workflows/repository-checks.yml').read_text())
        steps = workflow['jobs']['configuration']['steps']
        action = next(step for step in steps if step.get('id') == 'changeset-coverage')
        self.assertEqual(
            action['uses'],
            'grasdouble/Lufa-CICD/actions/check-changesets@9e985a3bb7fd2892e1075bed1c87acd4c1f527d8',
        )
        self.assertEqual(action['with']['base-sha'], '${{ github.event.pull_request.base.sha }}')
        self.assertEqual(action['with']['head-sha'], '${{ github.event.pull_request.head.sha }}')
        self.assertIn('steps.changeset-validation.outputs.generated-version-pr', action['if'])
        self.assertEqual(
            action['with']['ignore-patterns'].splitlines(),
            [
                '**/test/**',
                '**/tests/**',
                '**/__tests__/**',
                '**/*.test.*',
                '**/*.spec.*',
                '**/*.md',
                '**/*.adoc',
            ],
        )
        failure = next(step for step in steps if step.get('name') == 'Fail when changed workspaces lack Changesets')
        self.assertIn("steps.changeset-coverage.outputs.missing-count != '0'", failure['if'])
        self.assertIn('exit 1', failure['run'])
        validation = next(step for step in steps if step.get('id') == 'changeset-validation')
        self.assertIn('--workspace-head-sha', validation['run'])
        validation_args = shlex.split(validation['run'])
        self.assertEqual(
            [validation_args[index + 1] for index, arg in enumerate(validation_args[:-1]) if arg == '--exclude-path'],
            action['with']['ignore-patterns'].splitlines(),
        )
        self.assertLess(
            next(index for index, step in enumerate(steps) if step.get('name') == 'Checkout PR head for head-only workspace discovery'),
            steps.index(action),
        )
        self.assertLess(steps.index(action), next(index for index, step in enumerate(steps) if step.get('name') == 'Restore PR merge candidate checkout'))

    def test_runtime_integration_is_consolidated_and_uses_exact_event_candidate_without_secrets(self):
        root = Path(__file__).resolve().parents[2]
        self.assertFalse((root / '.github/workflows/on-demand-runtime-integration.yml').exists())
        workflow = load_yaml((root / '.github/workflows/repository-checks.yml').read_text())
        self.assertEqual(set(workflow['on']), {'pull_request', 'push', 'workflow_dispatch'})
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        dispatch_input = workflow['on']['workflow_dispatch']['inputs']['require_scenario_metrics']
        self.assertEqual(dispatch_input['type'], 'boolean')
        self.assertIs(dispatch_input['required'], False)
        self.assertIs(dispatch_input['default'], False)
        self.assertIn('timing metrics', dispatch_input['description'])
        self.assertIn('post-producer main-branch run', dispatch_input['description'])
        job = workflow['jobs']['runtime-integration']
        self.assertEqual(job['timeout-minutes'], 25)
        self.assertEqual(workflow['jobs']['configuration']['timeout-minutes'], 10)
        self.assertFalse(any(step.get('id') == 'runtime-integration-tests'
                             for step in workflow['jobs']['configuration']['steps']))
        steps = job['steps']
        self.assertTrue(all(re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', step['uses'])
                            for step in steps if 'uses' in step))
        checkout = next(step for step in steps if step.get('uses', '').startswith('actions/checkout@'))
        self.assertIn('github.event.pull_request.base.sha || github.event.repository.default_branch',
                      checkout['with']['ref'])
        self.assertFalse(checkout['with']['persist-credentials'])
        self.assertEqual(workflow['on']['push'], {'branches': ['main']})
        self.assertEqual(workflow['on']['pull_request']['types'],
                         ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'])
        select = next(step for step in steps if step.get('name') == 'Select exact integration candidate revision')
        self.assertIn('github.event.pull_request.head.sha', select['env']['PR_HEAD_SHA'])
        self.assertIn('github.sha', select['env']['EVENT_SHA'])
        self.assertIn('refs/pull/$PR_NUMBER/head', select['run'])
        self.assertIn('git fetch --no-tags --depth=1 origin "$EVENT_REF"', select['run'])
        self.assertIn('git rev-parse FETCH_HEAD^{commit}', select['run'])
        self.assertIn('test "$(git rev-parse HEAD)" = "$candidate_sha"', select['run'])
        preserve = next(step for step in steps if step.get('name') == 'Preserve candidate report helper outside candidate workspace')
        self.assertIn('cp scripts/ci/manual_integration_report.py "$RUNNER_TEMP/manual_integration_report.py"', preserve['run'])
        self.assertIn('cmp scripts/ci/manual_integration_report.py "$RUNNER_TEMP/manual_integration_report.py"', preserve['run'])
        pnpm_setup = next(step for step in steps if step.get('id') == 'runtime-pnpm')
        dependency_setup = next(item for item in steps if item.get('id') == 'runtime-dependencies')
        self.assertLess(steps.index(select), steps.index(preserve))
        self.assertLess(steps.index(preserve), steps.index(pnpm_setup))
        report_step = next(step for step in steps if step.get('id') == 'runtime-integration-tests')
        self.assertLess(steps.index(preserve), steps.index(report_step))
        for step in (pnpm_setup, dependency_setup, report_step):
            self.assertIn('$RUNNER_TEMP/manual_integration_report.py', step['run'])
            self.assertEqual(step['env']['GH_TOKEN'], '')
            self.assertEqual(step['env']['GITHUB_TOKEN'], '')
        self.assertEqual(report_step['env']['JARVIS_RUN_STOP_RUNTIME_INTEGRATION'], '1')
        self.assertIn('github.event_name', report_step['env']['EVENT_NAME'])
        self.assertIn('github.ref', report_step['env']['EVENT_REF'])
        self.assertIn('github.event.pull_request.head.sha || github.sha', report_step['env']['EVENT_SHA'])
        self.assertIn('github.event.pull_request.number', report_step['env']['PR_NUMBER'])
        self.assertEqual(report_step['env']['REQUIRE_SCENARIO_METRICS'], '${{ inputs.require_scenario_metrics }}')
        self.assertIn('--event "$EVENT_NAME" --ref "$EVENT_REF" --sha "$EVENT_SHA"', report_step['run'])
        self.assertIn('if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then', report_step['run'])
        self.assertIn('true|false) set -- "$@" --require-scenario-metrics "$REQUIRE_SCENARIO_METRICS" ;;', report_step['run'])
        self.assertIn("elif [ -n \"$REQUIRE_SCENARIO_METRICS\" ] && [ \"$REQUIRE_SCENARIO_METRICS\" != false ]; then", report_step['run'])
        self.assertIn('Scenario metrics override is only valid for workflow_dispatch.', report_step['run'])
        self.assertIn("Invalid require_scenario_metrics workflow input.", report_step['run'])
        self.assertIn('--pr "$PR_NUMBER" --base "$PR_BASE_SHA" --head "$PR_HEAD_SHA"', report_step['run'])
        self.assertIn('$RUNNER_TEMP/integration-report.json', report_step['run'])
        artifact = next(step for step in steps if step.get('uses', '').startswith('actions/upload-artifact@'))
        self.assertEqual(artifact['with']['path'], '${{ runner.temp }}/integration-report.json')
        self.assertEqual(artifact['with']['name'], 'runtime-integration-report')
        failure = next(step for step in steps if step.get('name') == 'Fail when required runtime integration evidence is missing or failed')
        self.assertIn('steps.runtime-integration-tests.outcome != \'success\'', failure['if'])

    def test_integration_jobs_use_unique_per_run_database_names(self):
        root = Path(__file__).resolve().parents[2]
        workflow = load_yaml((root / '.github/workflows/repository-checks.yml').read_text())
        for job_name, kind in [('configuration', 'auto'), ('runtime-integration', 'manual')]:
            with self.subTest(job=job_name):
                job = workflow['jobs'][job_name]
                database = f'jarvis_integration_{kind}_${{{{ github.run_id }}}}_${{{{ github.run_attempt }}}}'
                service = job['services']['postgres']
                self.assertEqual(service['env']['POSTGRES_DB'], database)
                self.assertEqual(service['image'],
                                 'postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c')
                self.assertIn('pg_isready -U jarvis_ci -d $POSTGRES_DB', service['options'])
                self.assertEqual(job['env']['POSTGRES_DB'], database)
                self.assertEqual(job['env']['JARVIS_TEST_DATABASE_URL'].rsplit('/', 1)[-1], database)
                self.assertEqual(job['env']['JARVIS_TEST_EXPECTED_DATABASE_NAME'], database)
                self.assertEqual(service['ports'], ['5432:5432'])
                self.assertIn('${{ github.run_id }}', database)
                self.assertIn('${{ github.run_attempt }}', database)

    def test_integration_test_guard_uses_explicit_run_database_contract(self):
        root = Path(__file__).resolve().parents[2]
        source = (root / 'packages/persistence/test/persistence.integration.test.mjs').read_text()
        guard = source[source.index('function validateExpectedDatabaseName'):source.index('function validateRestoreGateDatabaseUrl')]
        self.assertIn('const expectedDatabaseName = process.env.JARVIS_TEST_EXPECTED_DATABASE_NAME;', source)
        self.assertIn(r'/^jarvis_integration_(?:auto|manual)_[0-9]+_[0-9]+$/', guard)
        self.assertIn('assert.equal(database.name, expectedDatabaseName', source)
        self.assertNotIn('jarvis_integration_auto', guard)
        self.assertNotIn('jarvis_integration_manual', guard)

    def test_existing_local_link_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'target.md').write_text('Target\n')
            page = root / 'README.md'
            page.write_text('[Target](target.md)\n')
            check_markdown(page, root)

    def test_missing_link_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            page = root / 'README.md'
            page.write_text('[Missing](missing.md)\n')
            with self.assertRaises(ValueError):
                check_markdown(page, root)

    def test_link_outside_repository_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            page = root / 'README.md'
            page.write_text('[Outside](../)\n')
            with self.assertRaises(ValueError):
                check_markdown(page, root)


if __name__ == '__main__':
    unittest.main()
