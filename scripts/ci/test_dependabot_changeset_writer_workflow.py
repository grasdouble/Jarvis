"""Guard the trusted workflow-run boundary and least-privilege writer contract."""

from pathlib import Path
import unittest

from check_repository import load_yaml


ROOT = Path(__file__).resolve().parents[2]
SIGNAL_PATH = ROOT / '.github/workflows/dependabot-changesets.yml'
WRITER_PATH = ROOT / '.github/workflows/dependabot-changesets-writer.yml'
APP_TOKEN_ACTION = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510'


class DependabotChangesetWriterWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.signal = load_yaml(SIGNAL_PATH.read_text())
        cls.writer = load_yaml(WRITER_PATH.read_text())
        cls.writer_text = WRITER_PATH.read_text()

    def test_pr_signal_has_no_secrets_write_permissions_or_candidate_execution(self):
        self.assertEqual(set(self.signal['on']), {'pull_request'})
        self.assertEqual(self.signal['on']['pull_request']['branches'], ['main'])
        self.assertEqual(self.signal['permissions'], {'contents': 'read'})
        self.assertEqual(self.signal['jobs']['signal']['permissions'], {})
        self.assertEqual(self.signal['jobs']['signal']['timeout-minutes'], 5)
        steps = self.signal['jobs']['signal']['steps']
        self.assertTrue(all('uses' not in step for step in steps))
        self.assertTrue(all('run' in step for step in steps))
        text = SIGNAL_PATH.read_text()
        self.assertNotIn('secrets.', text)
        self.assertNotIn('APP_PRIVATE_KEY', text)
        self.assertNotIn('pull_request_target', text)

    def test_signal_check_says_it_is_not_merge_readiness(self):
        job = self.signal['jobs']['signal']
        self.assertEqual(job['name'], 'Signal only (not merge readiness)')
        summary = '\n'.join(step['run'] for step in job['steps'])
        self.assertIn('It does not mean the trusted writer has completed', summary)
        self.assertIn('Repository configuration', summary)
        self.assertIn('current PR head', summary)
        self.assertIn('GITHUB_STEP_SUMMARY', summary)

    def test_privileged_workflow_is_main_context_workflow_run_with_read_only_validation(self):
        self.assertEqual(set(self.writer['on']), {'workflow_run'})
        self.assertEqual(self.writer['on']['workflow_run']['workflows'], ['Dependabot changesets signal'])
        self.assertEqual(self.writer['on']['workflow_run']['types'], ['completed'])
        self.assertEqual(self.writer['permissions'], {'contents': 'read'})
        self.assertIn("github.ref == 'refs/heads/main'", self.writer['jobs']['validate']['if'])
        self.assertEqual(
            self.writer['jobs']['validate']['permissions'],
            {'actions': 'read', 'contents': 'read', 'pull-requests': 'read'},
        )
        self.assertEqual(
            self.writer['jobs']['write']['permissions'],
            {'actions': 'read', 'contents': 'read', 'pull-requests': 'read'},
        )
        self.assertEqual(self.writer['jobs']['write']['needs'], 'validate')
        self.assertNotIn('secrets.', str(self.writer['jobs']['validate']))

    def test_app_key_is_only_referenced_by_main_restricted_environment_writer_after_preflight(self):
        jobs = self.writer['jobs']
        self.assertNotIn('environment', jobs['validate'])
        writer_job = jobs['write']
        self.assertEqual(writer_job['environment']['name'], 'dependabot-changesets')
        steps = writer_job['steps']
        key_refs = [
            (index, step)
            for index, step in enumerate(steps)
            if 'DEPENDABOT_CHANGESET_APP_PRIVATE_KEY' in str(step)
        ]
        self.assertEqual(len(key_refs), 1)
        token_index, token = key_refs[0]
        secret_refs = [step for step in steps if 'secrets.' in str(step)]
        self.assertEqual(secret_refs, [token])
        self.assertEqual(token['uses'], APP_TOKEN_ACTION)
        self.assertEqual(token['with']['private-key'], '${{ secrets.DEPENDABOT_CHANGESET_APP_PRIVATE_KEY }}')
        self.assertEqual(token['with']['owner'], 'grasdouble')
        self.assertEqual(token['with']['repositories'], 'Jarvis')
        self.assertEqual(token['with']['permission-contents'], 'write')
        self.assertNotIn('installation-id', token['with'])
        self.assertEqual(token['if'], "${{ steps.plan.outputs.should_write == 'true' }}")
        plan_index = next(index for index, step in enumerate(steps) if step.get('id') == 'plan')
        self.assertLess(plan_index, token_index)
        identity_index = next(index for index, step in enumerate(steps) if step.get('id') == 'identity')
        writer_index = next(
            index for index, step in enumerate(steps)
            if 'dependabot_changeset_api.mjs write' in step.get('run', '')
        )
        self.assertLess(token_index, identity_index)
        self.assertLess(identity_index, writer_index)
        self.assertNotIn('pull_request_target', self.writer_text)

    def test_writer_never_checks_out_or_downloads_untrusted_pr_content(self):
        for forbidden in (
            'actions/download-artifact',
            'actions/upload-artifact',
            'pull_request_target',
            'github.event.workflow_run.head_sha }}\n          fetch-depth',
            'github.event.workflow_run.head_sha',
            'refs/pull/',
        ):
            self.assertNotIn(forbidden, self.writer_text)
        checkouts = [
            step for job in self.writer['jobs'].values() for step in job.get('steps', [])
            if step.get('uses', '').startswith('actions/checkout@')
        ]
        self.assertTrue(checkouts)
        self.assertTrue(all(step['with']['ref'] == '${{ github.sha }}' for step in checkouts))
        self.assertTrue(all(step['with']['persist-credentials'] is False for step in checkouts))

    def test_writer_uses_api_revalidation_plan_and_non_force_commit_without_lufa(self):
        text = self.writer_text
        self.assertIn('dependabot_changeset_api.mjs plan', text)
        self.assertIn('dependabot_changeset_api.mjs write', text)
        self.assertIn('EXPECTED_PLAN_DIGEST', text)
        self.assertIn('TRUSTED_WORKSPACES_JSON: ${{ steps.plan.outputs.trusted_workspaces_json }}', text)
        self.assertIn('force: false', (ROOT / 'scripts/ci/dependabot_changeset_api.mjs').read_text())
        self.assertNotIn('grasdouble/Lufa-CICD', text)
        self.assertNotIn('actions/upload-artifact', text)
        self.assertIn("vars.DEPENDABOT_CHANGESET_ENABLED == 'true'", self.writer['jobs']['validate']['if'])
        self.assertIn('dependabot-changesets-${{ github.event.workflow_run.pull_requests[0].number', self.writer['concurrency']['group'])
        self.assertIs(self.writer['concurrency']['cancel-in-progress'], False)
        docs = (ROOT / 'docs/development-workflow.md').read_text()
        self.assertIn('environment `dependabot-changesets`, restricted server-side to branch `main`', docs)
        self.assertIn('needs no Lufa allowlist exception', docs)

    def test_npm_workspace_monitoring_preserves_existing_ecosystems(self):
        config = load_yaml((ROOT / '.github/dependabot.yml').read_text())
        ecosystems = {(entry['package-ecosystem'], entry['directory']) for entry in config['updates']}
        self.assertEqual(ecosystems, {('github-actions', '/'), ('pip', '/.github'), ('npm', '/')})


if __name__ == '__main__':
    unittest.main()
