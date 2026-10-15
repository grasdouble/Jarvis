"""Exercise malformed and unsafe inputs to the repository configuration check."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from check_repository import check_markdown, check_workflow, load_yaml


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
        workflow = self.valid_workflow()
        workflow['permissions'] = {'contents': 'write'}
        with self.assertRaises(ValueError):
            check_workflow(workflow)

    def test_missing_timeout_is_rejected(self):
        workflow = deepcopy(self.valid_workflow())
        del workflow['jobs']['check']['timeout-minutes']
        with self.assertRaises(ValueError):
            check_workflow(workflow)

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

