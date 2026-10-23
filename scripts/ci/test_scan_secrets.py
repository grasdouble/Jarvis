"""Exercise PR history scoping with the pinned Gitleaks binary in disposable repos."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scan_secrets import scan


GITLEAKS = os.environ.get('GITLEAKS_BIN')
# Synthetic fake values intentionally match a Gitleaks test pattern; never print them.
FAKE_FINDING = 'AKIAQWERTY' + 'UIOPASDFGH'


def git(repo, *args, check=True):
    result = subprocess.run(
        ['git', '-C', str(repo), *args], text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if check and result.returncode:
        raise AssertionError('git fixture operation failed')
    return result.stdout.strip()


@unittest.skipUnless(GITLEAKS, 'set GITLEAKS_BIN to the pinned scanner')
class SecretScanTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name)
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.email', 'test@example.invalid')
        git(self.repo, 'config', 'user.name', 'Fixture')
        (self.repo / 'history.txt').write_text('clean baseline\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'base')
        self.base = git(self.repo, 'rev-parse', 'HEAD')

    def tearDown(self):
        self.temporary.cleanup()

    def commit(self, text, message):
        (self.repo / 'history.txt').write_text(text + '\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', message)
        return git(self.repo, 'rev-parse', 'HEAD')

    def assert_scan(self, expected, base=None, head=None, event='pull_request'):
        # Keep scanner findings and diagnostics out of test logs.
        original = Path.cwd()
        try:
            os.chdir(self.repo)
            with open(os.devnull, 'w') as sink:
                old_out, old_err = os.dup(1), os.dup(2)
                try:
                    os.dup2(sink.fileno(), 1)
                    os.dup2(sink.fileno(), 2)
                    result = scan(GITLEAKS, event, base or self.base, head)
                finally:
                    os.dup2(old_out, 1)
                    os.dup2(old_err, 2)
                    os.close(old_out)
                    os.close(old_err)
        finally:
            os.chdir(original)
        self.assertEqual(result == 0, expected)

    def test_pr_introduced_finding_fails(self):
        head = self.commit(FAKE_FINDING, 'introduced fake finding')
        self.assert_scan(False, head=head)

    def test_unrelated_ref_finding_does_not_affect_pr_scan(self):
        head = self.commit('clean PR change', 'PR change')
        git(self.repo, 'checkout', '-qb', 'unrelated', self.base)
        self.commit(FAKE_FINDING, 'unrelated fake finding')
        self.assert_scan(True, head=head)

    def test_multi_commit_pr_range_is_scanned(self):
        self.commit('first clean PR commit', 'first PR commit')
        head = self.commit(FAKE_FINDING, 'second fake PR finding')
        self.assert_scan(False, head=head)

    def test_diverged_head_uses_merge_base_not_current_base(self):
        self.commit('base-side change', 'base advances')
        current_base = git(self.repo, 'rev-parse', 'HEAD')
        git(self.repo, 'checkout', '-qb', 'pr-head', self.base)
        head = self.commit(FAKE_FINDING, 'PR finding from diverged head')
        self.assert_scan(False, base=current_base, head=head)

    def test_missing_or_unavailable_sha_fails_clearly(self):
        original = Path.cwd()
        try:
            os.chdir(self.repo)
            with self.assertRaisesRegex(ValueError, 'valid base SHA'):
                scan(GITLEAKS, 'pull_request', None, self.base)
            with self.assertRaisesRegex(ValueError, 'cannot access required head commit'):
                scan(GITLEAKS, 'pull_request', self.base, 'f' * 40)
        finally:
            os.chdir(original)

    def test_non_pr_full_history_still_catches_finding(self):
        self.commit(FAKE_FINDING, 'fake full-history finding')
        self.assert_scan(False, event='push')


if __name__ == '__main__':
    unittest.main()
