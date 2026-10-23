"""Run the repository's pinned Gitleaks scan with event-appropriate history scope."""

import argparse
import os
import re
import subprocess
import sys


SHA = re.compile(r'^[0-9a-fA-F]{40}$')


def git(*args):
    return subprocess.run(
        ['git', *args], check=True, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.strip()


def scan(binary, event_name, base_sha=None, head_sha=None):
    if event_name != 'pull_request':
        return subprocess.run(
            [binary, 'git', '.', '--redact', '--no-banner'], check=False,
        ).returncode

    for label, sha in (('base', base_sha), ('head', head_sha)):
        if not sha or not SHA.fullmatch(sha):
            raise ValueError(f'PR secret scan requires a valid {label} SHA.')
        try:
            git('cat-file', '-e', f'{sha}^{{commit}}')
        except subprocess.CalledProcessError as error:
            raise ValueError(f'PR secret scan cannot access required {label} commit.') from error
    try:
        merge_base = git('merge-base', base_sha, head_sha)
    except subprocess.CalledProcessError as error:
        raise ValueError('PR secret scan cannot find a merge-base for base and head.') from error
    # Supplying this explicit log option replaces Gitleaks' default all-ref scan.
    # Keep --all absent: unrelated refs must not enter this PR's scan.
    log_opts = f'--full-history {merge_base}..{head_sha}'
    return subprocess.run(
        [binary, 'git', '.', '--redact', '--no-banner', f'--log-opts={log_opts}'],
        check=False,
    ).returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gitleaks', required=True)
    parser.add_argument('--event-name', required=True)
    parser.add_argument('--base-sha', default=os.getenv('PR_BASE_SHA'))
    parser.add_argument('--head-sha', default=os.getenv('PR_HEAD_SHA'))
    args = parser.parse_args()
    try:
        return scan(args.gitleaks, args.event_name, args.base_sha, args.head_sha)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
