import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkIssue,
  createGitHubClient,
  evaluateCoordinationParent,
  parseAcceptanceCriteria,
} from './check-coordination-parent.mjs';
import { renderChildDeliveryComment, renderFinalAssessmentComment } from './coordination-parent-comments.mjs';

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
const app = 'jarvis-development-grasdouble[bot]';

function appComment(body) {
  return { body, user: { login: app } };
}

function deliveryComment(parentNumber, childNumber) {
  const mergeRevision = childNumber === 12 ? 'c'.repeat(40) : 'a'.repeat(40);
  const reviewedRevision = childNumber === 12 ? 'd'.repeat(40) : 'b'.repeat(40);
  const payload = {
    schemaVersion: 2,
    parentIssue: parentNumber,
    childIssue: childNumber,
    state: 'closed',
    stateReason: 'completed',
    evidenceStatus: 'validated',
    reason: null,
    evidence: [
      {
        url: `https://github.com/grasdouble/Jarvis/pull/${100 + childNumber}`,
        label: 'Merged child delivery PR',
        sourceType: 'pull_request',
        status: 'merged',
        revision: mergeRevision,
        reviewedRevision,
        childIssue: childNumber,
      },
      {
        url: `https://github.com/grasdouble/Jarvis/actions/runs/${200 + childNumber}`,
        label: 'Required current-head checks passed',
        sourceType: 'workflow_run',
        status: 'success',
        revision: reviewedRevision,
        childIssue: childNumber,
      },
    ],
  };
  return appComment(renderChildDeliveryComment(payload));
}

function finalComment(parentNumber, body, firstChild = 11, secondChild = 12) {
  const parsed = body.match(/## Acceptance criteria\n((?:- \[[ xX]\] .*\n?)+)/);
  const texts = parsed[1].trimEnd().split('\n').map(line => line.replace(/^- \[[ xX]\] /, ''));
  const prEvidence = (childNumber, mergeSha, headSha) => ({
    url: `https://github.com/grasdouble/Jarvis/pull/${100 + childNumber}`,
    label: `Child ${childNumber} merged PR`, sourceType: 'pull_request', status: 'merged',
    revision: mergeSha, reviewedRevision: headSha, childIssue: childNumber,
  });
  const checkEvidence = (childNumber, headSha) => ({
    url: `https://github.com/grasdouble/Jarvis/actions/runs/${200 + childNumber}`,
    label: `Child ${childNumber} checks`, sourceType: 'workflow_run', status: 'success',
    revision: headSha, childIssue: childNumber,
  });
  const firstDelivery = [prEvidence(firstChild, 'a'.repeat(40), 'b'.repeat(40)), checkEvidence(firstChild, 'b'.repeat(40))];
  const secondDelivery = [prEvidence(secondChild, 'c'.repeat(40), 'd'.repeat(40)), checkEvidence(secondChild, 'd'.repeat(40))];
  return appComment(renderFinalAssessmentComment({
    schemaVersion: 1,
    parentIssue: parentNumber,
    childCount: 2,
    criteria: texts.map((text, index) => ({
      index: index + 1,
      text,
      status: 'validated',
      reason: null,
      outcomes: index === 0 ? [{
        description: 'The implementation child delivery is evidenced.',
        kind: 'child',
        status: 'validated',
        childIssues: [firstChild],
        evidence: firstDelivery,
        rationale: '',
      }] : [{
        description: 'The cross-child integration is evidenced.',
        kind: 'integration',
        status: 'validated',
        childIssues: [firstChild, secondChild],
        evidence: [
          ...firstDelivery,
          ...secondDelivery,
          { url: 'https://github.com/grasdouble/Jarvis/actions/runs/222', label: 'Integrated fixture', sourceType: 'workflow_run', status: 'success', revision: '9'.repeat(40) },
        ],
        rationale: '',
      }],
    })),
  }));
}

const acceptedComments = [deliveryComment(10, 11), deliveryComment(10, 12), finalComment(10, acceptedBody)];

function makeClient({ issues = new Map(), parents = {}, pages = {}, comments = {} } = {}) {
  const calls = { getIssue: [], getParentNumber: [], listSubIssuePages: [], listIssueComments: [] };
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
    async listIssueComments(number) {
      calls.listIssueComments.push(number);
      return structuredClone(comments[number] ?? []);
    },
  };
}

test('parses one non-empty acceptance task list independent of checkbox state', () => {
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

test('fails closed for absent, duplicated, empty, and malformed criteria but permits unchecked items', () => {
  assert.equal(parseAcceptanceCriteria('## Notes\n- [x] unrelated').reason, 'criteria_missing');
  assert.equal(parseAcceptanceCriteria(`${acceptedBody}\n\n## Acceptance criteria\n- [x] duplicate`).reason, 'criteria_ambiguous');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\nNo task list.').reason, 'criteria_empty');
  assert.deepEqual(parseAcceptanceCriteria('## Acceptance criteria\n- [ ] pending'), {
    valid: true, total: 1, unchecked: 1,
  });
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

test('reports eligibility only when native children and comment evidence are complete', () => {
  assert.deepEqual(evaluateCoordinationParent({
    issue: child(11),
    parent: issue(10),
    childPages: acceptedPages,
    comments: acceptedComments,
  }), {
    decision: 'eligible_to_close',
    issue: 11,
    parent: 10,
    childCount: 2,
    criterionCount: 2,
  });
  assert.deepEqual(evaluateCoordinationParent({
    issue: child(11), parent: issue(10), childPages: acceptedPages, comments: [],
  }), {
    decision: 'not_eligible', issue: 11, parent: 10,
    reason: 'child_delivery_comment_missing', childCount: 2, criterionCount: 2, uncheckedCriteria: 0,
  });
});

test('accepts an all-validated final comment with unchecked body criteria and no body mutation', () => {
  const body = acceptedBody.replace('- [x]', '- [ ]').replace('- [X]', '- [ ]');
  const result = evaluateCoordinationParent({
    issue: child(11), parent: issue(10, { body }), childPages: acceptedPages,
    comments: [deliveryComment(10, 11), deliveryComment(10, 12), finalComment(10, body)],
  });
  assert.equal(result.decision, 'eligible_to_close');
});

test('rejects missing child delivery, stale criterion text, and non-App assessment comments', () => {
  assert.equal(evaluateCoordinationParent({
    issue: child(11), parent: issue(10), childPages: acceptedPages,
    comments: [deliveryComment(10, 11), finalComment(10, acceptedBody)],
  }).reason, 'child_delivery_comment_missing');

  const stale = finalComment(10, acceptedBody);
  const oldPayload = JSON.parse(Buffer.from(stale.body.match(/data:v1:([^ ]+)/)[1], 'base64url').toString());
  oldPayload.criteria[0].text = 'Old criterion wording.';
  const oldData = Buffer.from(JSON.stringify(oldPayload)).toString('base64url');
  stale.body = stale.body.replace(/data:v1:[^ ]+/, `data:v1:${oldData}`);
  assert.equal(evaluateCoordinationParent({
    issue: child(11), parent: issue(10), childPages: acceptedPages,
    comments: [...acceptedComments.slice(0, 2), stale],
  }).reason, 'final_assessment_invalid');

  const forged = finalComment(10, acceptedBody);
  forged.user.login = 'other-user';
  assert.equal(evaluateCoordinationParent({
    issue: child(11), parent: issue(10), childPages: acceptedPages,
    comments: [...acceptedComments.slice(0, 2), forged],
  }).reason, 'final_assessment_invalid');
});

test('reports no parent for ordinary issues and can inspect an issue that is itself a parent', () => {
  const ordinary = issue(20, { sub_issues_summary: { total: 0 } });
  assert.equal(evaluateCoordinationParent({ issue: ordinary, parent: null, childPages: null }).decision, 'no_parent');
  const result = evaluateCoordinationParent({
    issue: issue(10),
    parent: null,
    childPages: acceptedPages,
    comments: acceptedComments,
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
    comments: { 10: acceptedComments },
  });
  const result = await checkIssue(client, 11);
  assert.equal(result.decision, 'eligible_to_close');
  assert.deepEqual(client.calls, {
    getIssue: [11, 10],
    getParentNumber: [11],
    listSubIssuePages: [10],
    listIssueComments: [10],
  });
  assert.equal('closeIssue' in client, false);
});

test('GitHub adapter uses the reviewed CLI helper for fully paginated children and comments', () => {
  const calls = [];
  const cli = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'repos/grasdouble/Jarvis/issues/11') {
      return JSON.stringify(child(11));
    }
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ parent: { number: 10 } });
    if (args[0] === 'api' && args.at(-1).includes('/sub_issues?')) return JSON.stringify(acceptedPages);
    if (args[0] === 'api' && args.at(-1).includes('/comments?')) return JSON.stringify([acceptedComments]);
    throw new Error('Unexpected command.');
  };
  const client = createGitHubClient(cli);

  assert.equal(client.getIssue(11).number, 11);
  assert.equal(client.getParentNumber(11), 10);
  assert.deepEqual(client.listSubIssuePages(10), acceptedPages);
  assert.deepEqual(client.listIssueComments(10), acceptedComments);
  assert.deepEqual(calls[0], ['api', 'repos/grasdouble/Jarvis/issues/11']);
  assert.deepEqual(calls[1], ['issue', 'view', '11', '--repo', 'grasdouble/Jarvis', '--json', 'parent']);
  assert.deepEqual(calls[2], [
    'api', '--method', 'GET', '--paginate', '--slurp',
    'repos/grasdouble/Jarvis/issues/10/sub_issues?per_page=100',
  ]);
  assert.deepEqual(calls[3], [
    'api', '--method', 'GET', '--paginate', '--slurp',
    'repos/grasdouble/Jarvis/issues/10/comments?per_page=100',
  ]);
  assert.equal(calls.some(args => args.includes('--write')), false);
});

test('a status check can assess the selected coordination parent itself', async () => {
  const client = makeClient({
    issues: new Map([[10, issue(10)]]),
    pages: { 10: acceptedPages },
    comments: { 10: acceptedComments },
  });
  assert.equal((await checkIssue(client, 10)).decision, 'eligible_to_close');
  assert.deepEqual(client.calls.listSubIssuePages, [10]);
});

test('checks JV-032 and its native children using synthetic data without a special exclusion', async () => {
  const parent = issue(32);
  const comments32 = [deliveryComment(32, 11), deliveryComment(32, 12), finalComment(32, parent.body)];
  const direct = makeClient({
    issues: new Map([[32, parent]]),
    pages: { 32: acceptedPages },
    comments: { 32: comments32 },
  });
  assert.equal((await checkIssue(direct, 32)).decision, 'eligible_to_close');
  assert.deepEqual(direct.calls, {
    getIssue: [32], getParentNumber: [32], listSubIssuePages: [32], listIssueComments: [32],
  });

  const childClient = makeClient({
    issues: new Map([[33, child(33)], [32, parent]]),
    parents: { 33: 32 },
    pages: { 32: acceptedPages.map(page => page.map(item => item.number === 11 ? child(33) : item)) },
    comments: { 32: [deliveryComment(32, 33), deliveryComment(32, 12), finalComment(32, parent.body, 33, 12)] },
  });
  const childResult = await checkIssue(childClient, 33);
  assert.equal(childResult.decision, 'eligible_to_close');
  assert.deepEqual(childClient.calls, {
    getIssue: [33, 32], getParentNumber: [33], listSubIssuePages: [32], listIssueComments: [32],
  });
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
