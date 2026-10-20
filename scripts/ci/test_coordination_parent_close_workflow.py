"""Guard the trusted-source and least-privilege closure workflow contract."""

from pathlib import Path
import re
import unittest

from check_repository import load_yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/coordination-parent-close.yml'


class CoordinationParentCloseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = load_yaml(WORKFLOW.read_text())

    def test_event_and_permissions_are_narrow(self):
        self.assertEqual(set(self.workflow['on']), {'issues'})
        self.assertEqual(self.workflow['on']['issues']['types'], ['edited', 'closed', 'reopened'])
        self.assertEqual(self.workflow['permissions'], {'contents': 'read'})
        self.assertEqual(
            self.workflow['jobs']['close-parent']['permissions'],
            {'contents': 'read', 'issues': 'write'},
        )
        self.assertEqual(self.workflow['jobs']['close-parent']['timeout-minutes'], 5)

    def test_only_trusted_main_source_and_pinned_actions_are_used(self):
        steps = self.workflow['jobs']['close-parent']['steps']
        checkout, setup_node, run = steps
        self.assertEqual(
            checkout['with'],
            {
                'repository': 'grasdouble/Jarvis',
                'ref': 'main',
                'persist-credentials': False,
            },
        )
        self.assertTrue(re.fullmatch(r'actions/checkout@[0-9a-f]{40}', checkout['uses']))
        self.assertTrue(re.fullmatch(r'actions/setup-node@[0-9a-f]{40}', setup_node['uses']))
        self.assertEqual(setup_node['with'], {'node-version': '24'})
        self.assertEqual(run['run'], 'node scripts/ci/close_coordination_parents.mjs')
        self.assertEqual(run['env'], {'GITHUB_TOKEN': '${{ github.token }}'})
        self.assertNotIn('github.event', run['run'])
        self.assertFalse(any('cache' in step.get('with', {}) for step in steps))


if __name__ == '__main__':
    unittest.main()
