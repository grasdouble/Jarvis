import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findIssuesWithoutMilestones } from './check-issue-milestones.mjs';

const milestone = (extra = {}) => ({ number: 7, state: 'open', title: 'J6 — Improvements', ...extra });
const issue = (number, extra = {}) => ({ number, state: 'open', milestone: milestone(), ...extra });
const cli = fileURLToPath(new URL('./check-issue-milestones.mjs', import.meta.url));
const runCli = (text, args) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-milestone-audit-'));
  try {
    const path = join(directory, 'inventory.json');
    writeFileSync(path, text);
    return spawnSync(process.execPath, [cli, ...(args ?? [path])], {
      encoding: 'utf8', env: { PATH: process.env.PATH },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('audits actual issues in every state across pages while excluding PRs', () => {
  const pages = [[
    issue(100, { milestone: null }),
    issue(2, { state: 'closed', milestone: null }),
    issue(3, { pull_request: { url: 'https://api.github.com/repos/grasdouble/Jarvis/pulls/3' }, milestone: null }),
    issue(4, { milestone: milestone({ state: 'closed' }) }),
  ], [
    issue(57, { title: 'JV-044 coordination parent', sub_issues_summary: { total: 3 }, milestone: null }),
    issue(58, { milestone: milestone() }),
  ]];
  const before = structuredClone(pages);
  assert.deepEqual(findIssuesWithoutMilestones(pages), [2, 57, 100]);
  assert.deepEqual(pages, before, 'the pure audit must not mutate its inventory');
});

test('null, absent and blank native milestones are missing', () => {
  const absent = issue(1);
  delete absent.milestone;
  assert.deepEqual(findIssuesWithoutMilestones([[
    absent, issue(2, { milestone: null }), issue(3, { milestone: '' }),
    issue(4, { milestone: ' \t' }), issue(5, { milestone: milestone({ title: ' \n' }) }),
  ]]), [1, 2, 3, 4, 5]);
});

test('an empty REST page is a valid empty inventory', () => {
  assert.deepEqual(findIssuesWithoutMilestones([[]]), []);
  assert.deepEqual(findIssuesWithoutMilestones([[issue(1)]]), []);
});

test('invalid or duplicate pages and issue identities fail closed', () => {
  for (const inventory of [
    null, {}, [], [null], [{}], [issue(1)], [[null]], [[[]]], [[{}]],
    [[issue('1')]], [[issue(0)]], [[issue(-1)]], [[issue(1.5)]],
    [[issue(Number.MAX_SAFE_INTEGER + 1)]], [[issue(1, { state: 'OPEN' })]],
    [[issue(1, { state: null })]], [[issue(1)], [issue(1)]],
  ]) assert.throws(() => findIssuesWithoutMilestones(inventory), /Invalid issue inventory/);
});

test('malformed native milestone and PR metadata fail closed', () => {
  for (const value of [false, 7, [], {}, 'J6', { title: 'J6' },
    milestone({ number: '7' }), milestone({ number: 0 }),
    milestone({ state: 'OPEN' }), milestone({ title: null }),
  ]) assert.throws(() => findIssuesWithoutMilestones([[issue(1, { milestone: value })]]), /Invalid issue inventory/);
  for (const pull_request of [null, false, [], {}, { url: 3 }, { url: '' }]) {
    assert.throws(() => findIssuesWithoutMilestones([[issue(1, { pull_request })]]), /Invalid issue inventory/);
  }
});

test('CLI fails on missing milestones and emits only trusted issue links', () => {
  const hostile = '\n::error file=README.md::injected\u001b[31m $(secret)';
  const result = runCli(JSON.stringify([[issue(57, { title: hostile, html_url: hostile, milestone: null })]]));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'https://github.com/grasdouble/Jarvis/issues/57\n');
  assert.equal(result.stderr, 'Issues without a native milestone: 1.\n');
  assert.doesNotMatch(result.stdout + result.stderr, /::error|secret|\u001b|README/);
});

test('CLI succeeds for empty and fully milestoned inventories without credentials', () => {
  for (const pages of [[[]], [[issue(1)], [issue(2, { state: 'closed' })]]]) {
    const result = runCli(JSON.stringify(pages));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'All issues have a native milestone.\n');
    assert.equal(result.stderr, '');
  }
});

test('CLI rejects invalid JSON, shape, unreadable files and argument errors safely', () => {
  for (const [text, args] of [
    ['{::error injected', undefined], ['{}', undefined], ['[]', undefined],
    ['[[{"number":"::error injected","state":"open"}]]', undefined],
    ['', []], ['', ['::error missing-file']], ['', ['one', 'two']],
  ]) {
    const result = runCli(text, args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^(Invalid issue inventory\.|Usage: node \.agents\/skills\/jarvis-project-management\/scripts\/github\/check-issue-milestones\.mjs <inventory\.json>)\n$/);
    assert.doesNotMatch(result.stderr, /::error|injected|missing-file/);
  }
});
