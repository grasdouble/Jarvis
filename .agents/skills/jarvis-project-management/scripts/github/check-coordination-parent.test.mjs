import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkIssue,
  createGitHubClient,
  evaluateCoordinationParent,
  parseAcceptanceCriteria,
} from './check-coordination-parent.mjs';

const repositoryUrl = 'https://api.github.com/repos/grasdouble/Jarvis';
const acceptedBody = `## Outcome
Coordinate the work.

## Acceptance criteria
- [x] Deliver the implementation.
- [X] Verify the integration.

## Notes
More context.`;

const issue = (number, extra = {}) => ({
  number,
  state: 'open',
  state_reason: null,
  body: acceptedBody,
  repository_url: repositoryUrl,
  sub_issues_summary: { total: 2 },
  ...extra,
});

const child = (number, extra = {}) => ({
  number,
  state: 'closed',
  state_reason: 'completed',
  repository_url: repositoryUrl,
  ...extra,
});

const acceptedPages = [[child(11), child(12)]];

function makeClient({ issues = new Map(), parents = {}, pages = {} } = {}) {
  const calls = { getIssue: [], getParentNumber: [], listSubIssuePages: [] };
  return {
    calls,
    async getIssue(number) {
      calls.getIssue.push(number);
      const result = issues.get(number);
      if (!result) throw new Error('Unexpected issue read.');
      return structuredClone(result);
    },
    async getParentNumber(number) {
      calls.getParentNumber.push(number);
      return parents[number] ?? null;
    },
    async listSubIssuePages(number) {
      calls.listSubIssuePages.push(number);
      const result = pages[number];
      if (result instanceof Error) throw result;
      return structuredClone(result ?? [[]]);
    },
  };
}

test('parses one non-empty acceptance task list and ignores fenced examples', () => {
  const body = `## Other
- [ ] unrelated

## Acceptance criteria
- [x] required

~~~markdown
- [ ] example only
~~~

## Follow-up
- [ ] unrelated`;
  assert.deepEqual(parseAcceptanceCriteria(body), { valid: true, total: 1, unchecked: 0 });
});

test('fails closed for absent, duplicated, empty, unchecked, and malformed criteria', () => {
  assert.equal(parseAcceptanceCriteria('## Notes\n- [x] unrelated').reason, 'criteria_missing');
  assert.equal(parseAcceptanceCriteria(`${acceptedBody}\n\n## Acceptance criteria\n- [x] duplicate`).reason, 'criteria_ambiguous');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\nNo task list.').reason, 'criteria_empty');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [ ] pending').reason, 'criteria_unchecked');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [y] invalid').reason, 'criteria_malformed');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [x]').reason, 'criteria_malformed');
});

test('fails closed when comment markers occur in code, escaped text, or indented HTML', () => {
  const inline = [
    '## Acceptance criteria',
    '- [x] literal `<!--` in code',
    '- [ ] visibly unchecked',
    '- [x] literal `-->` in code',
  ].join('\n');
  const indentedComment = [
    '## Acceptance criteria',
    '- [x] checked',
    '    <!-- this is an indented code block, not a comment',
    '- [ ] visibly unchecked',
    '    -->',
  ].join('\n');
  const escapedComment = '## Acceptance criteria\n- [x] literal \\<!-- opener';

  for (const body of [inline, indentedComment, escapedComment]) {
    assert.equal(parseAcceptanceCriteria(body).valid, false);
    assert.equal(evaluateCoordinationParent({
      issue: child(11),
      parent: issue(10, { body }),
      childPages: acceptedPages,
    }).decision, 'not_eligible');
  }
  assert.equal(parseAcceptanceCriteria(inline).reason, 'criteria_malformed');
  assert.equal(parseAcceptanceCriteria(indentedComment).reason, 'criteria_malformed');
  assert.equal(parseAcceptanceCriteria(escapedComment).reason, 'criteria_malformed');
});

test('does not count checklist-shaped text inside raw HTML or block quotes', () => {
  const html = '## Acceptance criteria\n<div>\n- [x] plain text, not a task list\n</div>';
  const quote = '## Acceptance criteria\n> - [x] quoted text\n- [x] actual criterion';
  assert.equal(parseAcceptanceCriteria(html).reason, 'criteria_malformed');
  assert.equal(parseAcceptanceCriteria(quote).reason, 'criteria_malformed');
});

test('reports eligibility only when native children are complete and criteria are checked', () => {
  assert.deepEqual(evaluateCoordinationParent({
    issue: child(11),
    parent: issue(10),
    childPages: acceptedPages,
  }), {
    decision: 'eligible_to_close',
    issue: 11,
    parent: 10,
    childCount: 2,
    criterionCount: 2,
  });
});

test('reports no parent for ordinary issues and can inspect an issue that is itself a parent', () => {
  const ordinary = issue(20, { sub_issues_summary: { total: 0 } });
  assert.equal(evaluateCoordinationParent({ issue: ordinary, parent: null, childPages: null }).decision, 'no_parent');
  const result = evaluateCoordinationParent({
    issue: issue(10),
    parent: null,
    childPages: acceptedPages,
  });
  assert.equal(result.decision, 'eligible_to_close');
  assert.equal(result.parent, 10);
});

test('incomplete pages, count mismatches, duplicates, pull requests, and foreign issues fail closed', () => {
  const parent = issue(10);
  const cases = [
    null,
    [],
    [[child(11)]],
    [[child(11), child(11)]],
    [[child(11), { ...child(12), pull_request: {} }]],
    [[child(11), { ...child(12), repository_url: 'https://api.github.com/repos/other/Repo' }]],
  ];
  for (const childPages of cases) {
    assert.equal(evaluateCoordinationParent({ issue: child(11), parent, childPages }).decision, 'unable_to_assess');
  }
});

test('open, abandoned, invalid-state children and closed parents are never eligible', () => {
  for (const unfinished of [
    { ...child(11), state: 'open', state_reason: null },
    { ...child(11), state_reason: 'not_planned' },
    { ...child(11), state_reason: 'unknown' },
  ]) {
    const result = evaluateCoordinationParent({
      issue: child(11),
      parent: issue(10, { sub_issues_summary: { total: 1 } }),
      childPages: [[unfinished]],
    });
    assert.notEqual(result.decision, 'eligible_to_close');
  }
  const closedParent = issue(10, { state: 'closed', state_reason: 'completed' });
  assert.equal(evaluateCoordinationParent({ issue: child(11), parent: closedParent, childPages: acceptedPages }).reason, 'parent_already_closed');
});

test('an issue with a native parent is checked read-only, without any mutation capability', async () => {
  const client = makeClient({
    issues: new Map([[11, child(11)], [10, issue(10)]]),
    parents: { 11: 10 },
    pages: { 10: acceptedPages },
  });
  const result = await checkIssue(client, 11);
  assert.equal(result.decision, 'eligible_to_close');
  assert.deepEqual(client.calls, {
    getIssue: [11, 10],
    getParentNumber: [11],
    listSubIssuePages: [10],
  });
  assert.equal('closeIssue' in client, false);
});

test('GitHub adapter uses the reviewed CLI helper for reads and fully paginated native children', () => {
  const calls = [];
  const cli = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'repos/grasdouble/Jarvis/issues/11') {
      return JSON.stringify(child(11));
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ parent: { number: 10 } });
    if (args[0] === 'api') return JSON.stringify(acceptedPages);
    throw new Error('Unexpected command.');
  };
  const client = createGitHubClient(cli);

  assert.equal(client.getIssue(11).number, 11);
  assert.equal(client.getParentNumber(11), 10);
  assert.deepEqual(client.listSubIssuePages(10), acceptedPages);
  assert.deepEqual(calls[0], ['api', 'repos/grasdouble/Jarvis/issues/11']);
  assert.deepEqual(calls[1], ['issue', 'view', '11', '--repo', 'grasdouble/Jarvis', '--json', 'parent']);
  assert.deepEqual(calls[2], [
    'api', '--method', 'GET', '--paginate', '--slurp',
    'repos/grasdouble/Jarvis/issues/10/sub_issues?per_page=100',
  ]);
  assert.equal(calls.some(args => args.includes('--write')), false);
});

test('a status check can assess the selected coordination parent itself', async () => {
  const client = makeClient({
    issues: new Map([[10, issue(10)]]),
    pages: { 10: acceptedPages },
  });
  assert.equal((await checkIssue(client, 10)).decision, 'eligible_to_close');
  assert.deepEqual(client.calls.listSubIssuePages, [10]);
});

test('JV-032 and children whose native parent is JV-032 are excluded', async () => {
  const direct = makeClient();
  assert.deepEqual(await checkIssue(direct, 32), { decision: 'excluded', issue: 32 });
  assert.deepEqual(direct.calls, { getIssue: [], getParentNumber: [], listSubIssuePages: [] });

  const childClient = makeClient({
    issues: new Map([[33, child(33)]]),
    parents: { 33: 32 },
  });
  assert.deepEqual(await checkIssue(childClient, 33), { decision: 'excluded', issue: 33, parent: 32 });
  assert.deepEqual(childClient.calls, { getIssue: [33], getParentNumber: [33], listSubIssuePages: [] });
});

test('malformed or unavailable API data yields no eligible result', async () => {
  const failedClient = makeClient({ issues: new Map([[11, child(11)]]), parents: { 11: 10 } });
  await assert.rejects(checkIssue(failedClient, 11), /Unexpected issue read/);
  assert.equal(evaluateCoordinationParent({ issue: {}, parent: null, childPages: null }).decision, 'unable_to_assess');
  const invalidStateClient = makeClient({
    issues: new Map([[11, child(11, { state_reason: 'unknown' })]]),
  });
  assert.deepEqual(await checkIssue(invalidStateClient, 11), {
    decision: 'unable_to_assess', issue: 11, reason: 'invalid_issue_data',
  });
});
