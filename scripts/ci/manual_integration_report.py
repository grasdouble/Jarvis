"""Run PostgreSQL runtime integration checks and emit a bounded evidence report."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

REQUIRED_SCENARIO = 'real PostgreSQL stop controls gate and cancel the real queue worker composition'
# PR #270 remains the initial exact-head acceptance target. Later reports are
# gated by producer presence in the trusted PR base or event revision.
METRICS_REQUIRED_PR = 270
DIAGNOSTIC_BYTES = 8192
DIAGNOSTIC_LINES = 120
SCENARIO_METRIC_PREFIX = '# single PostgreSQL-backed in-process sample:'
SCENARIO_METRIC_LINE_BYTES = 1024


def bounded_diagnostics(text):
    secrets = sorted({value for key, value in os.environ.items()
                      if value and re.search(r'(?:TOKEN|PASSWORD|PASS|SECRET|DATABASE_URL|DB_URL)', key, re.I)},
                     key=len, reverse=True)
    for secret in secrets:
        text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'(?i)(postgres(?:ql)?://[^:/\s]+):[^@/\s]+@', r'\1:[REDACTED]@', text)
    text = re.sub(r'(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})', '[REDACTED]', text)
    lines = text.splitlines()
    if len(lines) > DIAGNOSTIC_LINES:
        lines = lines[:DIAGNOSTIC_LINES - 1] + ['[diagnostics truncated]']
    result = '\n'.join(lines)
    encoded = result.encode('utf-8')
    if len(encoded) > DIAGNOSTIC_BYTES:
        suffix = '\n[diagnostics truncated]'
        result = encoded[:DIAGNOSTIC_BYTES - len(suffix.encode())].decode('utf-8', 'ignore').rstrip() + suffix
    return result


def candidate_from_values(event_name, ref, sha, pr_number='', base_sha='', head_sha='',
                          require_scenario_metrics='false', producer_present='false'):
    if require_scenario_metrics not in {'true', 'false'}:
        raise ValueError('Scenario metrics override must be true or false.')
    if producer_present not in {'true', 'false'}:
        raise ValueError('Scenario producer presence must be true or false.')
    if require_scenario_metrics == 'true' and (event_name != 'workflow_dispatch' or ref != 'refs/heads/main'):
        raise ValueError('Required scenario metrics may be explicitly requested only for main workflow_dispatch.')
    if event_name not in {'pull_request', 'push', 'workflow_dispatch'}:
        raise ValueError('Unsupported event name.')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Event SHA must be 40 lowercase hexadecimal characters.')
    if event_name == 'pull_request':
        if not re.fullmatch(r'[1-9][0-9]{0,8}', str(pr_number)):
            raise ValueError('Pull request number must be a positive integer.')
        if ref != f'refs/pull/{pr_number}/merge':
            raise ValueError('Pull request ref must match its event number.')
        if not re.fullmatch(r'[0-9a-f]{40}', base_sha) or not re.fullmatch(r'[0-9a-f]{40}', head_sha):
            raise ValueError('Pull request base and head must be 40 lowercase hexadecimal characters.')
        if sha != head_sha:
            raise ValueError('Pull request candidate SHA must be its exact event head SHA.')
        candidate = {'event': event_name, 'ref': ref, 'sha': sha,
                     'pr': int(pr_number), 'base': base_sha, 'head': head_sha}
        if producer_present == 'true':
            candidate['metrics_required'] = True
            candidate['metrics_requirement_source'] = 'producer-in-base'
        elif int(pr_number) == METRICS_REQUIRED_PR:
            candidate['metrics_required'] = True
            candidate['metrics_requirement_source'] = 'initial-target-pr'
        return candidate
    if (not re.fullmatch(r'refs/heads/[A-Za-z0-9._/-]+', ref) or '..' in ref or
            ref.endswith(('/', '.')) or '//' in ref):
        raise ValueError('Push and manual-dispatch event refs must select a branch.')
    if any((pr_number, base_sha, head_sha)):
        raise ValueError('Pull request context is only valid for pull_request events.')
    candidate = {'event': event_name, 'ref': ref, 'sha': sha}
    if producer_present == 'true' or require_scenario_metrics == 'true':
        candidate['metrics_required'] = True
        candidate['metrics_requirement_source'] = ('producer-in-event-revision' if producer_present == 'true'
                                                   else 'manual-dispatch-override')
    return candidate


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


def parse_required_scenario_metrics(text, metrics_required):
    """Extract the exact bounded metric diagnostic; permit the legacy generic diagnostic elsewhere."""
    lines = [line for line in text.splitlines() if is_scenario_metric_line(line)]
    if not lines:
        if metrics_required:
            raise ValueError('Required stop-manager scenario metrics are missing.')
        return None
    if len(lines) != 1:
        raise ValueError('Required stop-manager scenario metrics must appear exactly once.')
    line = lines[0]
    if not line.startswith(SCENARIO_METRIC_PREFIX):
        raise ValueError('Required stop-manager scenario metrics are malformed.')
    if len(line.encode('utf-8')) > SCENARIO_METRIC_LINE_BYTES:
        raise ValueError('Required stop-manager scenario metrics exceed the line size limit.')
    secrets = [value for key, value in os.environ.items()
               if value and re.search(r'(?:TOKEN|PASSWORD|PASS|SECRET|DATABASE_URL|DB_URL)', key, re.I)]
    if any(secret in line for secret in secrets) or re.search(
            r'(?i)(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|postgres(?:ql)?://)', line):
        raise ValueError('Required stop-manager scenario metrics contain secret-like data.')
    legacy_pattern = re.compile(
        r'^# single PostgreSQL-backed in-process sample: project stop to stopped worker claim attempt '
        r'\d+(?:\.\d+)?ms \(no dispatch; task remains queued\); active stop to synthetic HTTPS/mTLS manager '
        r'cancellation request \d+(?:\.\d+)?ms; active stop/cancel completion \d+(?:\.\d+)?ms\. Local '
        r'synthetic evidence only; no OS process restart or production latency qualification\.$')
    if legacy_pattern.fullmatch(line):
        if metrics_required:
            raise ValueError('Required stop-manager scenario metrics are missing.')
        return None
    pattern = re.compile(
        r'^# single PostgreSQL-backed in-process sample: project stop to stopped worker claim attempt '
        r'(?P<no_dispatch>\d+(?:\.\d+)?)ms \(no dispatch; task remains queued\); active stop to synthetic '
        r'HTTPS/mTLS manager cancellation request (?P<request>\d+(?:\.\d+)?)ms; manager accepted request but '
        r'withheld response for (?P<withheld>\d+(?:\.\d+)?)ms; configured client timeout (?P<timeout>\d+)ms; '
        r'active stop/cancel completion (?P<completion>\d+(?:\.\d+)?)ms\. Local synthetic evidence only; '
        r'no OS process restart or production latency qualification\.$')
    match = pattern.fullmatch(line)
    if not match:
        raise ValueError('Required stop-manager scenario metrics are malformed.')
    values = {key: float(match.group(key)) for key in ('no_dispatch', 'request', 'withheld', 'completion')}
    if (int(match.group('timeout')) != 300 or values['no_dispatch'] > 2_000 or values['request'] > 10_000 or
            not 250 <= values['withheld'] <= 1_300 or not 250 <= values['completion'] <= 1_300):
        raise ValueError('Required stop-manager scenario metrics are outside configured bounds.')
    return {
        'scenario': 'stop-manager-nonresponse', 'configured_client_timeout_ms': 300,
        'no_dispatch_stop_to_worker_claim_attempt_ms': values['no_dispatch'],
        'active_stop_to_cancel_request_ms': values['request'],
        'manager_withheld_response_ms': values['withheld'],
        'active_stop_cancel_completion_ms': values['completion'],
    }


def is_scenario_metric_line(line):
    return (line.startswith(SCENARIO_METRIC_PREFIX) or
            re.search(r'(?i)(?:withheld response for|configured client timeout)', line) is not None)


def run_report(candidate, output):
    commands = [
        ['pnpm', '--filter', '@jarvis/api', 'build'],
        ['pnpm', '--filter', '@jarvis/worker', 'build'],
        ['pnpm', '--filter', '@jarvis/persistence', 'test'],
    ]
    start_time = datetime.now(timezone.utc)
    command_results = []
    setup_results = json.loads(os.environ.get('JARVIS_SETUP_RESULTS', '[]'))
    test_output = ''
    command_results.extend(setup_results)
    for command in commands if not any(item['exit_code'] != 0 for item in setup_results) else []:
        command_started_at = datetime.now(timezone.utc)
        started = time.monotonic()
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, check=False)
        elapsed = round(time.monotonic() - started, 3)
        command_results.append({'command': ' '.join(command), 'exit_code': result.returncode,
                                'duration_seconds': elapsed, 'started_at_utc': command_started_at.isoformat(),
                                'ended_at_utc': datetime.now(timezone.utc).isoformat()})
        if command[-1] == 'test':
            test_output = result.stdout
        if result.returncode:
            break
    end_time = datetime.now(timezone.utc)
    test_result = result if command_results and command_results[-1]['command'].endswith(' test') else type(
        'Result', (), {'returncode': next((x['exit_code'] for x in command_results if x['exit_code']), 1)})()
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
    try:
        scenario_metrics = parse_required_scenario_metrics(
            test_output, metrics_required=candidate.get('metrics_required', False)
        ) if test_was_run else None
        metrics_error = None
    except ValueError as error:
        scenario_metrics, metrics_error = None, str(error)
    passed = (not command_failed and test_was_run and parse_error is None and scenario_error is None
              and metrics_error is None
              and totals['tests'] > 0 and totals['fail'] == 0 and totals['skipped'] == 0
              and totals['cancelled'] == 0 and totals['todo'] == 0)
    report = {
        **candidate, 'commands': command_results, 'setup_commands': setup_results,
        'integration_status': 'not_run' if not test_was_run else 'run',
        'result': 'pass' if passed else 'fail',
        'started_at_utc': start_time.isoformat(), 'ended_at_utc': end_time.isoformat(),
        'exit_code': test_result.returncode, 'duration_seconds': round(sum(x['duration_seconds'] for x in command_results), 3), 'tap': totals,
        'scenarios': scenarios, 'tap_parse_error': parse_error, 'required_scenario_error': scenario_error,
        'scenario_metrics_error': metrics_error,
        'evidence_limitations': [
            'Runtime integration qualification evidence only; it does not establish issue acceptance or runtime relay behavior.',
            'The test suite uses synthetic/local boundaries and an ephemeral PostgreSQL service.',
            'Scenario timings are one in-process synthetic HTTPS/mTLS sample; they do not qualify OS process restart, production latency, or Colima/macOS behavior.',
        ],
    }
    if passed and scenario_metrics is not None:
        report['scenario_metrics'] = scenario_metrics
    if not passed and test_output:
        safe_test_output = '\n'.join(
            '[invalid stop-manager scenario metrics omitted]' if is_scenario_metric_line(line) else line
            for line in test_output.splitlines())
        report['failure_diagnostics'] = bounded_diagnostics(safe_test_output)
    Path(output).write_text(json.dumps(report, indent=2) + '\n')
    print('Integration report: ' + json.dumps(report, sort_keys=True))
    if not passed:
        raise SystemExit(1)


def record_command(command, output):
    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    record = {'command': ' '.join(command), 'exit_code': result.returncode,
              'duration_seconds': round(time.monotonic() - started, 3),
              'started_at_utc': started_at.isoformat(),
              'ended_at_utc': datetime.now(timezone.utc).isoformat()}
    Path(output).write_text(json.dumps(record) + '\n')
    print(result.stdout, end='')
    print(json.dumps(record))
    raise SystemExit(result.returncode)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    run = sub.add_parser('run')
    run.add_argument('--event', required=True)
    run.add_argument('--ref', required=True)
    run.add_argument('--sha', required=True)
    run.add_argument('--pr', default='')
    run.add_argument('--base', default='')
    run.add_argument('--head', default='')
    run.add_argument('--require-scenario-metrics', choices=('true', 'false'), default='false')
    run.add_argument('--producer-present', choices=('true', 'false'), default='false')
    run.add_argument('--output', required=True)
    record = sub.add_parser('record-command')
    record.add_argument('--output', required=True)
    record.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == 'record-command':
        command = args.command[1:] if args.command and args.command[0] == '--' else args.command
        record_command(command, args.output)
    else:
        try:
            candidate = candidate_from_values(args.event, args.ref, args.sha, args.pr, args.base, args.head,
                                              args.require_scenario_metrics, args.producer_present)
        except ValueError as error:
            print(f'Candidate arguments rejected: {error}', file=sys.stderr)
            raise SystemExit(1)
        run_report(candidate, args.output)


if __name__ == '__main__':
    main()
