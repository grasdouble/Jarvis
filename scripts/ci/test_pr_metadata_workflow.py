"""Characterize the credential boundary of the actual privileged workflow."""
from pathlib import Path
import unittest
from check_repository import load_yaml

ROOT = Path(__file__).resolve().parents[2]


def validate(data):
    job = data['jobs']['synchronize']
    assert data['permissions'] == {'contents': 'read'}
    assert job['environment'] == 'jarvis-project-sync'
    assert data['on']['pull_request_target']['branches'] == ['main']
    assert "github.ref == 'refs/heads/main'" in job['if']
    assert "vars.JARVIS_PROJECT_SYNC_ENABLED == 'true'" in job['if']
    steps = job['steps']
    assert len(steps) == 6
    checkout, node, token, identity, reconcile, roadmap = steps
    assert checkout['with'] == {'repository': 'grasdouble/Jarvis', 'ref': 'refs/heads/main', 'persist-credentials': False}
    assert token['uses'].startswith('actions/create-github-app-token@')
    assert token['with'] == {
        'client-id': 'Iv23lizUGCTbekJqlXGm',
        'private-key': '${{ secrets.PROJECT_SYNC_APP_PRIVATE_KEY }}',
        'owner': 'grasdouble', 'repositories': 'Jarvis',
        'permission-organization-projects': 'write', 'permission-pull-requests': 'write',
        'permission-issues': 'read', 'permission-metadata': 'read',
    }
    assert reconcile['run'] == 'node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --ci --write'
    assert reconcile['env'] == {'GH_TOKEN': '${{ steps.app.outputs.token }}'}
    assert identity['id'] == 'identity'
    assert roadmap['run'] == 'node .agents/skills/jarvis-project-management/scripts/github/sync-pr-project-metadata.mjs --roadmap --ci --write'
    assert roadmap['env'] == {'GH_TOKEN': '${{ steps.app.outputs.token }}'}
    assert roadmap['if'] == "${{ !cancelled() && steps.app.outcome == 'success' && steps.identity.outcome == 'success' }}"
    assert not any('cache' in step.get('with', {}) for step in steps)


class PrivilegedWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.data = load_yaml((ROOT / '.github/workflows/pr-project-metadata.yml').read_text())

    def test_actual_workflow_retains_trusted_main_and_minimal_token(self):
        validate(self.data)

    def test_candidate_checkout_is_rejected(self):
        self.data['jobs']['synchronize']['steps'][0]['with']['ref'] = '${{ github.event.pull_request.head.sha }}'
        with self.assertRaises(AssertionError):
            validate(self.data)

    def test_extra_credentials_or_token_permissions_are_rejected(self):
        self.data['jobs']['synchronize']['steps'][2]['with']['permission-contents'] = 'write'
        with self.assertRaises(AssertionError):
            validate(self.data)

    def test_missing_environment_gate_is_rejected(self):
        del self.data['jobs']['synchronize']['environment']
        with self.assertRaises((AssertionError, KeyError)):
            validate(self.data)


if __name__ == '__main__':
    unittest.main()
