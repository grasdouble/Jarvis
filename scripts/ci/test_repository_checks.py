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

    def test_manual_integration_workflow_is_dispatch_only_and_read_only(self):
        root = Path(__file__).resolve().parents[2]
        workflow = load_yaml((root / '.github/workflows/on-demand-runtime-integration.yml').read_text())
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        self.assertEqual(workflow['permissions'], {'contents': 'read', 'pull-requests': 'read'})
        self.assertEqual(set(workflow['on']['workflow_dispatch']['inputs']), {'pull_request', 'expected_head_sha'})
        steps = workflow['jobs']['qualify']['steps']
        self.assertTrue(all(re.fullmatch(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}', step['uses'])
                            for step in steps if 'uses' in step))
        existing = load_yaml((root / '.github/workflows/repository-checks.yml').read_text())
        self.assertEqual(set(existing['on']), {'pull_request', 'push', 'workflow_dispatch'})
        self.assertEqual(existing['on']['push'], {'branches': ['main']})
        self.assertEqual(existing['on']['pull_request']['types'],
                         ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'])
        names = [step.get('name', '') for step in steps]
        self.assertLess(names.index('Refuse non-default-branch or cross-repository dispatch before using a token'),
                        names.index('Verify PR and expected head against GitHub metadata'))
        metadata = next(step for step in steps if step.get('id') == 'candidate')
        self.assertIn('GITHUB_OUTPUT', metadata['run'])
        self.assertNotIn('candidate.json', metadata['run'])
        helper_copy = next(step for step in steps if step.get('name') == 'Preserve trusted report helper outside candidate workspace')
        self.assertLess(names.index(helper_copy['name']), names.index('Fetch exact validated candidate revision'))
        self.assertIn('refs/remotes/pull/$PR_NUMBER/head', next(step for step in steps if step.get('name') == 'Fetch exact validated candidate revision')['run'])
        self.assertIn('test "$fetched_sha" = "$CANDIDATE_SHA"', next(step for step in steps if step.get('name') == 'Fetch exact validated candidate revision')['run'])
        report_step = next(step for step in steps if step.get('id') == 'tests')
        self.assertIn('$RUNNER_TEMP/manual_integration_report.py', report_step['run'])
        self.assertIn('CANDIDATE_PR', report_step['run'])
        self.assertIn('--base "$CANDIDATE_BASE"', report_step['run'])
        self.assertIn('$RUNNER_TEMP/integration-report.json', report_step['run'])
        self.assertEqual(report_step['env']['CANDIDATE_PR'], '${{ steps.candidate.outputs.pr }}')
        self.assertIn('CANDIDATE_BASE', report_step['env'])
        self.assertIn('CANDIDATE_HEAD', report_step['env'])
        self.assertEqual(report_step['env']['JARVIS_RUN_STOP_RUNTIME_INTEGRATION'], '1')
        artifact = next(step for step in steps if step.get('uses', '').startswith('actions/upload-artifact@'))
        self.assertEqual(artifact['with']['path'], '${{ runner.temp }}/integration-report.json')
        self.assertNotIn('candidate.json', artifact['with']['path'])

    def test_manual_integration_database_name_is_consistent(self):
        root = Path(__file__).resolve().parents[2]
        workflow = load_yaml((root / '.github/workflows/on-demand-runtime-integration.yml').read_text())
        job = workflow['jobs']['qualify']
        database = 'jarvis_integration_manual'
        self.assertEqual(job['services']['postgres']['env']['POSTGRES_DB'], database)
        self.assertIn(f'pg_isready -U jarvis_ci -d {database}', job['services']['postgres']['options'])
        self.assertEqual(job['env']['POSTGRES_DB'], database)
        self.assertEqual(job['env']['JARVIS_TEST_DATABASE_URL'].rsplit('/', 1)[-1], database)

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
