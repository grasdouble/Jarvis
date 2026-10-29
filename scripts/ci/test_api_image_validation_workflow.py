"""Protect the API image CI workflow's validation and trust boundaries."""

from pathlib import Path
import unittest

from check_repository import load_yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / '.github/workflows/api-image-validation.yml'


class ApiImageValidationWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW_PATH.read_text()
        cls.workflow = load_yaml(cls.text)
        cls.job = cls.workflow['jobs']['validate-and-build']
        cls.steps = cls.job['steps']

    def test_trigger_and_permissions_are_read_only_and_bounded(self):
        self.assertEqual(set(self.workflow['on']), {'pull_request', 'push'})
        self.assertEqual(self.workflow['on']['push']['branches'], ['main'])
        self.assertEqual(self.workflow['permissions'], {'contents': 'read'})
        self.assertEqual(self.workflow['concurrency']['cancel-in-progress'], True)
        self.assertEqual(self.job['runs-on'], 'ubuntu-24.04')
        self.assertLessEqual(self.job['timeout-minutes'], 30)

    def test_compose_validation_uses_verified_compose_plugin_and_merged_files(self):
        install = next(s for s in self.steps if s.get('name') == 'Install and verify pinned Docker Compose')
        verify = next(s for s in self.steps if s.get('name') == 'Validate merged base and application Compose configuration')
        compose_binary = '/usr/local/lib/docker/cli-plugins/docker-compose'
        self.assertIn('v5.6.0/docker-compose-linux-x86_64', install['run'])
        self.assertIn('sha256sum --check', install['run'])
        self.assertIn('40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a', install['env']['COMPOSE_SHA256'])
        self.assertIn(f'install -D -m 0755 "$RUNNER_TEMP/docker-compose" {compose_binary}', install['run'])
        self.assertIn('mktemp -d "$RUNNER_TEMP/', verify['run'])
        self.assertIn("trap 'rm -rf \"$validation_dir\"' EXIT", verify['run'])
        self.assertIn('printf ', verify['run'])
        self.assertIn('"$validation_dir/secrets.compose.yaml"', verify['run'])
        self.assertIn('config --quiet', verify['run'])
        secret_names = set()
        for filename in ('compose.yaml', 'app.compose.yaml'):
            manifest = load_yaml((ROOT / 'infra/compose' / filename).read_text())
            secret_names.update(manifest.get('secrets', {}))
        for name in secret_names:
            self.assertRegex(
                verify['run'],
                rf'(?m)^\s+{name}:\n\s+file: \$validation_dir/secret$',
            )
        self.assertNotRegex(verify['run'], r'/etc/jarvis|/var/run/docker\.sock')
        self.assertEqual(self.job['env']['DOCKER_SOCKET_GID'], '999')

    def test_builds_and_inspects_real_arm64_image_without_publication(self):
        action_steps = [s for s in self.steps if s.get('uses', '').startswith('docker/')]
        self.assertEqual([s['uses'] for s in action_steps], [
            'docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1',
            'docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069',
            'docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc',
        ])
        build = action_steps[-1]['with']
        self.assertEqual(build['file'], 'infra/compose/Dockerfile')
        self.assertEqual(build['platforms'], 'linux/arm64')
        self.assertFalse(build['push'])
        self.assertTrue(build['load'])
        inspect = next(s for s in self.steps if s.get('name') == 'Confirm the loaded image architecture')
        self.assertIn('docker image inspect', inspect['run'])
        self.assertIn('linux/arm64', inspect['run'])

    def test_no_privileged_deployment_or_secret_surface(self):
        self.assertNotIn('${{ secrets.', self.text)
        self.assertNotIn('registry', self.text.lower())
        self.assertNotIn('colima', self.text.lower())
        self.assertNotIn('docker compose up', self.text.lower())
        self.assertNotIn('permissions:\n  contents: write', self.text)
        self.assertTrue(all(not s.get('uses', '').startswith('actions/checkout@') or
                            s.get('with', {}).get('persist-credentials') is False for s in self.steps))


if __name__ == '__main__':
    unittest.main()
