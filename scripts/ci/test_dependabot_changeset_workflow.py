"""Guard the trusted-code and least-privilege contract of JV-034 automation."""

from pathlib import Path
import unittest

from check_repository import load_yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / '.github/workflows/dependabot-changesets.yml'
LUFA_ACTION = (
    'grasdouble/Lufa-CICD/actions/dependabot-changeset'
    '@d13c591aef751743f19240acdc79b7e9cb0cfe1a'
)


def step_named(workflow, name):
    return next(step for step in workflow['jobs']['changeset']['steps'] if step.get('name') == name)


class DependabotChangesetWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = load_yaml(WORKFLOW_PATH.read_text())
        self.job = self.workflow['jobs']['changeset']
        self.steps = self.job['steps']

    def test_trigger_requires_enabled_same_repository_dependabot_pr_to_main(self):
        events = self.workflow['on']
        self.assertEqual(set(events), {'pull_request'})
        self.assertEqual(events['pull_request']['branches'], ['main'])
        condition = self.job['if']
        for condition_fact in (
            "github.repository == 'grasdouble/Jarvis'",
            "github.event.pull_request.user.login == 'dependabot[bot]'",
            "github.event.pull_request.head.repo.full_name == 'grasdouble/Jarvis'",
            "github.event.pull_request.base.repo.full_name == 'grasdouble/Jarvis'",
            "github.event.pull_request.base.ref == 'main'",
            "startsWith(github.event.pull_request.head.ref, 'dependabot/')",
            "vars.DEPENDABOT_CHANGESET_ENABLED == 'true'",
        ):
            self.assertIn(condition_fact, condition)
        self.assertNotIn('github.actor', condition)
        self.assertNotIn('pull_request_target', self.workflow)

    def test_pull_request_facts_are_reread_before_checkout_or_credentials(self):
        verify = step_named(self.workflow, 'Verify current Dependabot PR facts')
        script = verify['run']
        for trusted_fact in (
            '/pulls/', 'head_sha', 'base_sha', 'head_ref', 'base_ref',
            'head_repository', 'base_repository', "pull.get('user')",
            'dependabot[bot]',
        ):
            self.assertIn(trusted_fact, script)
        verify_index = self.steps.index(verify)
        token_index = self.steps.index(step_named(self.workflow, 'Create scoped Dependabot App token'))
        self.assertLess(verify_index, token_index)

    def test_only_exact_pr_revision_and_trusted_base_are_checked_out_without_credentials(self):
        head = step_named(self.workflow, 'Checkout Dependabot head')
        self.assertEqual(head['with']['ref'], '${{ github.event.pull_request.head.sha }}')
        self.assertEqual(head['with']['fetch-depth'], 0)
        self.assertIs(head['with']['persist-credentials'], False)

        base = step_named(self.workflow, 'Checkout trusted base workspace')
        self.assertEqual(base['with']['ref'], '${{ github.event.pull_request.base.sha }}')
        self.assertEqual(base['with']['path'], 'trusted-base')
        self.assertIs(base['with']['persist-credentials'], False)

    def test_trusted_checkout_is_moved_outside_the_clean_lufa_worktree(self):
        checkout = step_named(self.workflow, 'Checkout trusted base workspace')
        relocate = next(
            (step for step in self.steps if step.get('name') == 'Move trusted base outside candidate checkout'),
            None,
        )
        self.assertIsNotNone(relocate, 'The trusted checkout must leave the candidate worktree before Lufa runs.')
        setup_pnpm = step_named(self.workflow, 'Install pinned PNPM without reading candidate configuration')
        preflight = step_named(self.workflow, 'Preflight Dependabot changeset')
        action = step_named(self.workflow, 'Generate the Dependabot changeset')

        self.assertLess(self.steps.index(checkout), self.steps.index(relocate))
        self.assertLess(self.steps.index(relocate), self.steps.index(action))
        self.assertIn('mv "$TRUSTED_BASE" "$trusted_base"', relocate['run'])
        self.assertEqual(setup_pnpm['working-directory'], '${{ runner.temp }}/jv034-trusted-base')
        self.assertIn('node "$JARVIS_TRUSTED_BASE/scripts/ci/dependabot_changeset_preflight.mjs"', preflight['run'])
        self.assertNotIn('github.workspace/trusted-base/scripts', preflight['run'])

    def test_pnpm_and_preflight_use_trusted_base_before_any_write_token(self):
        setup_node = next(step for step in self.steps if step.get('uses', '').startswith('actions/setup-node@'))
        self.assertEqual(setup_node['with'], {'node-version': '24'})
        self.assertIn('npm install --global pnpm@12.5.1', '\n'.join(step.get('run', '') for step in self.steps))
        self.assertNotIn('pnpm install', '\n'.join(step.get('run', '') for step in self.steps))

        preflight = step_named(self.workflow, 'Preflight Dependabot changeset')
        self.assertIn('$JARVIS_TRUSTED_BASE/scripts/ci/dependabot_changeset_preflight.mjs', preflight['run'])
        self.assertIn('JARVIS_TRUSTED_BASE/scripts/ci/dependabot_pnpm_workspaces.mjs', '\n'.join(step.get('run', '') for step in self.steps))
        self.assertLess(self.steps.index(preflight), self.steps.index(step_named(self.workflow, 'Check dedicated App provisioning')))
        self.assertLess(self.steps.index(preflight), self.steps.index(step_named(self.workflow, 'Create scoped Dependabot App token')))

    def test_action_is_pinned_and_write_token_is_narrow_and_delayed(self):
        self.assertEqual(self.workflow['permissions'], {'contents': 'read'})
        self.assertEqual(self.job['permissions'], {'contents': 'read', 'pull-requests': 'read'})
        self.assertEqual(self.job['timeout-minutes'], 15)
        self.assertTrue(self.workflow['concurrency']['cancel-in-progress'])
        self.assertIn('pull_request.number', self.workflow['concurrency']['group'])

        token = step_named(self.workflow, 'Create scoped Dependabot App token')
        self.assertEqual(token['uses'], 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510')
        self.assertEqual(token['if'], "${{ steps.preflight.outputs.affected == 'true' }}")
        self.assertEqual(token['with']['owner'], 'grasdouble')
        self.assertEqual(token['with']['repositories'], 'Jarvis')
        self.assertEqual(token['with']['permission-contents'], 'write')
        self.assertNotIn('installation-id', token['with'])
        self.assertNotIn('permission-pull-requests', token['with'])
        self.assertEqual(token['with']['private-key'], '${{ secrets.DEPENDABOT_CHANGESET_APP_PRIVATE_KEY }}')

        action = step_named(self.workflow, 'Generate the Dependabot changeset')
        self.assertEqual(action['uses'], LUFA_ACTION)
        self.assertEqual(action['with'], {
            'base-sha': '${{ github.event.pull_request.base.sha }}',
            'head-sha': '${{ github.event.pull_request.head.sha }}',
            'head-branch': '${{ github.event.pull_request.head.ref }}',
            'pull-request-number': '${{ github.event.pull_request.number }}',
            'github-token': '${{ steps.app.outputs.token }}',
        })
        self.assertEqual(action['if'], "${{ steps.preflight.outputs.affected == 'true' && steps.identity.outcome == 'success' }}")

        noop = step_named(self.workflow, 'Report a deliberate no-op')
        self.assertEqual(noop['if'], "${{ steps.preflight.outputs.affected != 'true' }}")
        self.assertIn('DEPENDABOT_CHANGESET_APP_PRIVATE_KEY Dependabot secret is not provisioned', step_named(self.workflow, 'Check dedicated App provisioning')['run'])

    def test_legacy_changeset_guard_precedes_token_minting(self):
        guard = step_named(self.workflow, 'Preflight Dependabot changeset')
        source = (ROOT / 'scripts/ci/dependabot_changeset_preflight.mjs').read_text()
        self.assertIn(r'dependabot-\d+\.md', source)
        self.assertIn('DEPENDABOT_CHANGESET_PR_NUMBER', source)
        self.assertLess(self.steps.index(guard), self.steps.index(step_named(self.workflow, 'Create scoped Dependabot App token')))

    def test_npm_workspace_monitoring_is_added_without_changing_existing_ecosystems(self):
        config = load_yaml((ROOT / '.github/dependabot.yml').read_text())
        ecosystems = {(entry['package-ecosystem'], entry['directory']) for entry in config['updates']}
        self.assertEqual(ecosystems, {('github-actions', '/'), ('pip', '/.github'), ('npm', '/')})


if __name__ == '__main__':
    unittest.main()
