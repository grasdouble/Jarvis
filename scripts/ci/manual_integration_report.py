"""Validate a manually selected PR revision and emit its integration-test report."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

REQUIRED_SCENARIO = 'real PostgreSQL stop controls gate and cancel the real queue worker composition'


def metadata(pr_number, expected_sha, token):
    if not re.fullmatch(r'[1-9][0-9]{0,8}', pr_number):
        raise ValueError('PR number must be a positive integer.')
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha):
        raise ValueError('Expected head SHA must be 40 lowercase hexadecimal characters.')
    if not token:
        raise ValueError('A read-only GitHub token is required for PR metadata validation.')
    request = Request(
        f'https://api.github.com/repos/{os.environ["GITHUB_REPOSITORY"]}/pulls/{pr_number}',
        headers={'Accept': 'application/vnd.github+json', 'Authorization': f'Bearer {token}',
                 'X-GitHub-Api-Version': '2022-11-28'},
    )
    with urlopen(request, timeout=20) as response:
        pr = json.load(response)
    if (pr.get('state') != 'open' or pr.get('head', {}).get('sha') != expected_sha
            or not re.fullmatch(r'[0-9a-f]{40}', pr.get('base', {}).get('sha', ''))):
        raise ValueError('PR is not open at the exact expected head SHA.')
    return {'pr': int(pr_number), 'base': pr['base']['sha'], 'head': pr['head']['sha']}


def candidate_from_values(pr_number, base_sha, head_sha):
    if not re.fullmatch(r'[1-9][0-9]{0,8}', str(pr_number)):
        raise ValueError('PR number must be a positive integer.')
    if not re.fullmatch(r'[0-9a-f]{40}', base_sha) or not re.fullmatch(r'[0-9a-f]{40}', head_sha):
        raise ValueError('Candidate base and head must be 40 lowercase hexadecimal characters.')
    return {'pr': int(pr_number), 'base': base_sha, 'head': head_sha}


def write_github_output(path, candidate):
    candidate = candidate_from_values(candidate['pr'], candidate['base'], candidate['head'])
    with Path(path).open('a') as output:
        for key in ('pr', 'base', 'head'):
            output.write(f'{key}={candidate[key]}\n')


def parse_tap(text):
    keys = ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')
    records = re.findall(r'^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text, re.M)
    summaries = {}
    for key, value in records:
        summaries[key] = summaries.get(key, 0) + int(value)
    if not records or any(key not in summaries for key in keys):
        raise ValueError('No complete usable Node TAP summary found.')
    if summaries['tests'] == 0:
        raise ValueError('TAP summary reports zero executed tests.')
    scenarios = []
    for line in text.splitlines():
        tap_case = re.match(r'^\s*(not )?ok \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$', line)
        if tap_case:
            name = tap_case[2].strip()
            status = 'skip' if tap_case[3] else 'fail' if tap_case[1] else 'pass'
            scenarios.append({'status': status, 'name': name[:240]})
            continue
        match = re.match(r'^\s*(✔|✖|﹣|○)\s+(.+?)(?:\s+\([0-9.]+ms\))?(?:\s+#.*)?$', line)
        if match:
            scenarios.append({'status': {'✔': 'pass', '✖': 'fail', '﹣': 'skip', '○': 'skip'}[match[1]],
                              'name': match[2][:240]})
            if len(scenarios) >= 200:
                break
    return summaries, scenarios


def run_report(candidate, output):
    commands = [
        ['pnpm', '--filter', '@jarvis/api', 'build'],
        ['pnpm', '--filter', '@jarvis/worker', 'build'],
        ['pnpm', '--filter', '@jarvis/persistence', 'test'],
    ]
    start_time = datetime.now(timezone.utc)
    command_results = []
    test_output = ''
    for command in commands:
        started = time.monotonic()
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        elapsed = round(time.monotonic() - started, 3)
        command_results.append({'command': ' '.join(command), 'exit_code': result.returncode,
                                'duration_seconds': elapsed})
        if command[-1] == 'test':
            test_output = result.stdout
        if result.returncode:
            break
    end_time = datetime.now(timezone.utc)
    test_result = result
    command_failed = any(item['exit_code'] != 0 for item in command_results)
    test_was_run = command_results[-1]['command'].endswith(' test')
    try:
        totals, scenarios = parse_tap(test_output) if test_was_run else ({key: None for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')}, [])
        parse_error = None
    except ValueError as error:
        totals, scenarios, parse_error = {key: None for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')}, [], str(error)
    required = [item for item in scenarios if item['name'] == REQUIRED_SCENARIO]
    scenario_error = None
    if len(required) != 1:
        scenario_error = f'Required scenario must appear exactly once: {REQUIRED_SCENARIO}'
    elif required[0]['status'] != 'pass':
        scenario_error = f'Required scenario did not pass (status: {required[0]["status"]}): {REQUIRED_SCENARIO}'
    passed = (not command_failed and test_was_run and parse_error is None and scenario_error is None
              and totals['tests'] > 0 and totals['fail'] == 0 and totals['skipped'] == 0
              and totals['cancelled'] == 0 and totals['todo'] == 0)
    report = {
        **candidate, 'commands': command_results, 'result': 'pass' if passed else 'fail',
        'started_at_utc': start_time.isoformat(), 'ended_at_utc': end_time.isoformat(),
        'exit_code': test_result.returncode, 'duration_seconds': round(sum(x['duration_seconds'] for x in command_results), 3), 'tap': totals,
        'scenarios': scenarios, 'tap_parse_error': parse_error, 'required_scenario_error': scenario_error,
        'evidence_limitations': [
            'Manual qualification evidence only; it does not establish issue acceptance or runtime relay behavior.',
            'The test suite uses synthetic/local boundaries and an ephemeral PostgreSQL service.',
        ],
    }
    Path(output).write_text(json.dumps(report, indent=2) + '\n')
    print('Integration report: ' + json.dumps(report, sort_keys=True))
    if not passed:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    validate = sub.add_parser('validate')
    validate.add_argument('--pr', required=True)
    validate.add_argument('--sha', required=True)
    validate.add_argument('--github-output', required=True)
    validate.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    run = sub.add_parser('run')
    run.add_argument('--pr', required=True)
    run.add_argument('--base', required=True)
    run.add_argument('--head', required=True)
    run.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.action == 'validate':
        try:
            data = metadata(args.pr, args.sha, args.token)
        except Exception as error:
            print(f'Candidate validation failed: {error}', file=sys.stderr)
            raise SystemExit(1)
        write_github_output(args.github_output, data)
    else:
        try:
            candidate = candidate_from_values(args.pr, args.base, args.head)
        except ValueError as error:
            print(f'Candidate arguments rejected: {error}', file=sys.stderr)
            raise SystemExit(1)
        run_report(candidate, args.output)


if __name__ == '__main__':
    main()
