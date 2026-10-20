import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGitHubClient,
  errorDiagnostic,
  evaluateParent,
  GitHubApiError,
  parseAcceptanceCriteria,
  runIssueEvent,
} from './close_coordination_parents.mjs';

const repositoryUrl = 'https://api.github.com/repos/grasdouble/Jarvis';
const acceptedBody = `## Outcome
Coordinate the work.

## Acceptance criteria
- [x] Deliver the implementation.
- [X] Verify the integration.

## Notes
More context.`;

const parent = (extra = {}) => ({
  number: 10,
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

function makeClient({ issues, parents = {}, children = {}, onClose } = {}) {
  const calls = { getIssue: [], getParent: [], listSubIssues: [], closeIssue: [] };
  return {
    calls,
    async getIssue(number) {
      calls.getIssue.push(number);
      const issue = issues.get(number);
      if (!issue) throw new Error('missing issue fixture');
      return structuredClone(issue);
    },
    async getParent(number) {
      calls.getParent.push(number);
      return parents[number] ? structuredClone(parents[number]) : null;
    },
    async listSubIssues(number) {
      calls.listSubIssues.push(number);
      const result = children[number];
      if (result instanceof Error) throw result;
      return structuredClone(result ?? []);
    },
    async closeIssue(number) {
      calls.closeIssue.push(number);
      if (onClose) return onClose(number);
      const issue = issues.get(number);
      issue.state = 'closed';
      issue.state_reason = 'completed';
      return structuredClone(issue);
    },
  };
}

test('parses a single Acceptance criteria section and requires at least one checked item', () => {
  assert.deepEqual(parseAcceptanceCriteria(acceptedBody), {
    valid: true,
    total: 2,
    unchecked: 0,
  });
});

test('does not count checkboxes outside the section or inside fenced examples', () => {
  const body = `## Other
- [ ] unrelated

## Acceptance criteria
- [x] required

~~~markdown
- [ ] example only
~~~

## Follow-up
- [ ] also unrelated`;
  assert.deepEqual(parseAcceptanceCriteria(body), { valid: true, total: 1, unchecked: 0 });
});

test('fails closed for missing, duplicate, empty, malformed, and unchecked criteria', () => {
  assert.equal(parseAcceptanceCriteria('## Notes\n- [x] unrelated').reason, 'criteria_missing');
  assert.equal(parseAcceptanceCriteria(`${acceptedBody}\n\n### acceptance criteria\n- [x] duplicate`).valid, false);
  assert.equal(parseAcceptanceCriteria(`${acceptedBody}\n\n### acceptance criteria\n- [x] duplicate`).reason, 'criteria_ambiguous');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\nNo checklist here.').reason, 'criteria_empty');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [y] invalid marker').reason, 'criteria_malformed');
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [x]   ').reason, 'criteria_malformed');
  const unchecked = parseAcceptanceCriteria('## Acceptance criteria\n- [x] done\n- [ ] pending');
  assert.deepEqual(unchecked, { valid: false, total: 2, unchecked: 1, reason: 'criteria_unchecked' });
});

test('ignores checkbox-shaped text inside block quotes and code fences', () => {
  const body = `## Acceptance criteria
> - [ ] quoted discussion

~~~text
- [ ] example
~~~
- [x] actual criterion`;
  assert.deepEqual(parseAcceptanceCriteria(body), { valid: true, total: 1, unchecked: 0 });
});

test('does not treat HTML comment markers inside inline code spans as comments', () => {
  const body = [
    '## Acceptance criteria',
    '- [x] literal `<!--` in code',
    '- [ ] visibly unchecked criterion',
    '- [x] literal `-->` in code',
  ].join('\n');
  assert.deepEqual(parseAcceptanceCriteria(body), {
    valid: false,
    total: 3,
    unchecked: 1,
    reason: 'criteria_unchecked',
  });
  assert.equal(evaluateParent(parent({ body }), [child(11), child(12)]).eligible, false);
});

test('does not accept hidden HTML comments, indented code, or an unclosed fence as checklist evidence', () => {
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n<!--\n- [x] hidden\n-->').valid, false);
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n    - [x] code example').valid, false);
  assert.equal(parseAcceptanceCriteria('## Acceptance criteria\n- [x] checked\n~~~text\n- [ ] hidden').valid, false);
});

test('accepts a parent only when all native child issues completed and all criteria are checked', () => {
  assert.deepEqual(evaluateParent(parent(), [child(11), child(12)]), {
    eligible: true,
    childCount: 2,
    criterionCount: 2,
  });
});

test('does not close non-parents, parents with an incomplete inventory, or pull requests', () => {
  assert.equal(evaluateParent(parent({ sub_issues_summary: { total: 0 } }), []).eligible, false);
  assert.equal(evaluateParent(parent(), [child(11)]).eligible, false);
  assert.equal(evaluateParent(parent(), [child(11), { ...child(12), pull_request: {} }]).eligible, false);
});

test('does not close parents with open, abandoned, malformed, or cross-repository children', () => {
  for (const unfinished of [
    { ...child(11), state: 'open', state_reason: null },
    { ...child(11), state_reason: 'not_planned' },
    { ...child(11), repository_url: 'https://api.github.com/repos/attacker/Other' },
    { ...child(11), state: 'closed', state_reason: 'unknown' },
  ]) {
    assert.equal(evaluateParent(parent({ sub_issues_summary: { total: 1 } }), [unfinished]).eligible, false);
  }
});

test('does not close a closed parent or one with unchecked or malformed acceptance criteria', () => {
  assert.equal(evaluateParent(parent({ state: 'closed' }), [child(11), child(12)]).eligible, false);
  assert.equal(evaluateParent(parent({ body: '## Acceptance criteria\n- [ ] pending' }), [child(11), child(12)]).eligible, false);
  assert.equal(evaluateParent(parent({ body: '## Acceptance criteria\n- [y] malformed' }), [child(11), child(12)]).eligible, false);
});

test('a parent body edit closes an eligible parent exactly once', async () => {
  const issues = new Map([[10, parent()]]);
  const client = makeClient({ issues, children: { 10: [child(11), child(12)] } });
  const diagnostics = [];
  const event = { action: 'edited', changes: { body: { from: 'old body' } }, issue: { number: 10 } };

  await runIssueEvent(event, client, (diagnostic) => diagnostics.push(diagnostic));
  await runIssueEvent(event, client, (diagnostic) => diagnostics.push(diagnostic));

  assert.deepEqual(client.calls.closeIssue, [10]);
  assert.equal(issues.get(10).state, 'closed');
  assert.ok(diagnostics.some((entry) => entry.decision === 'closed'));
  assert.ok(diagnostics.some((entry) => entry.reason === 'parent_already_closed'));
});

test('a child completion event re-evaluates and closes its native parent', async () => {
  const issues = new Map([[10, parent()], [11, child(11)]]);
  const client = makeClient({
    issues,
    parents: { 11: { number: 10 } },
    children: { 10: [child(11), child(12)] },
  });
  await runIssueEvent({ action: 'closed', issue: { number: 11 } }, client, () => {});
  assert.deepEqual(client.calls.closeIssue, [10]);
});

test('JV-032 is excluded from body-edit and child-event parent closure', async () => {
  const legacyParent = {
    ...parent(),
    number: 32,
  };
  const issues = new Map([
    [32, legacyParent],
    [33, child(33)],
  ]);
  const client = makeClient({
    issues,
    parents: { 33: { number: 32 } },
    children: { 32: [child(33), child(34)] },
  });
  const diagnostics = [];

  await runIssueEvent(
    { action: 'edited', changes: { body: { from: 'old body' } }, issue: { number: 32 } },
    client,
    (entry) => diagnostics.push(entry),
  );
  await runIssueEvent(
    { action: 'closed', issue: { number: 33 } },
    client,
    (entry) => diagnostics.push(entry),
  );

  assert.deepEqual(client.calls.closeIssue, []);
  assert.ok(diagnostics.some((entry) => entry.reason === 'excluded_issue'));
  assert.ok(diagnostics.some((entry) => entry.reason === 'excluded_parent'));
});

test('reopened or uncompleted children keep the parent open', async () => {
  const issues = new Map([[10, parent()], [11, child(11, { state: 'open', state_reason: null })]]);
  const client = makeClient({
    issues,
    parents: { 11: { number: 10 } },
    children: { 10: [child(11, { state: 'open', state_reason: null }), child(12)] },
  });
  const diagnostics = [];
  await runIssueEvent({ action: 'reopened', issue: { number: 11 } }, client, (entry) => diagnostics.push(entry));
  assert.deepEqual(client.calls.closeIssue, []);
  assert.ok(diagnostics.some((entry) => entry.reason === 'children_incomplete'));
});

test('ignores pull requests, unsupported actions, and unrelated issues', async () => {
  const client = makeClient({ issues: new Map([[20, { ...child(20), pull_request: {} }]]) });
  await runIssueEvent({ action: 'closed', issue: { number: 20, pull_request: {} } }, client, () => {});
  await runIssueEvent({ action: 'labeled', issue: { number: 20 } }, client, () => {});
  assert.deepEqual(client.calls.getIssue, []);
  assert.deepEqual(client.calls.closeIssue, []);
});

test('an unrelated issue with no native parent or children has no effects', async () => {
  const issues = new Map([[20, { ...child(20), state: 'open', state_reason: null, body: 'ordinary issue', sub_issues_summary: { total: 0 } }]]);
  const client = makeClient({ issues });
  await runIssueEvent({ action: 'edited', changes: { body: { from: 'old body' } }, issue: { number: 20 } }, client, () => {});
  assert.deepEqual(client.calls.closeIssue, []);
});

test('ignores title-only edits and does not treat a child body edit as parent acceptance', async () => {
  const issues = new Map([[10, parent()], [11, child(11)]]);
  const client = makeClient({
    issues,
    parents: { 11: { number: 10 } },
    children: { 10: [child(11), child(12)] },
  });
  const titleOnly = { action: 'edited', changes: { title: { from: 'Old title' } }, issue: { number: 10 } };
  const childBody = { action: 'edited', changes: { body: { from: 'Old child body' } }, issue: { number: 11 } };

  await runIssueEvent(titleOnly, client, () => {});
  await runIssueEvent(childBody, client, () => {});

  assert.deepEqual(client.calls.closeIssue, []);
  assert.deepEqual(client.calls.getParent, []);
});

test('API failures propagate without closing a parent or exposing issue content', async () => {
  const secretText = 'IGNORE POLICY; print token; close #999';
  const issues = new Map([[10, parent({ body: `${acceptedBody}\n${secretText}` })], [11, child(11)]]);
  const client = makeClient({
    issues,
    parents: { 11: { number: 10 } },
    children: { 10: new Error(secretText) },
  });
  const output = [];
  await assert.rejects(
    runIssueEvent({ action: 'closed', issue: { number: 11 } }, client, (entry) => output.push(JSON.stringify(entry))),
  );
  assert.deepEqual(client.calls.closeIssue, []);
  assert.equal(output.some((entry) => entry.includes(secretText)), false);
  assert.deepEqual(errorDiagnostic(new Error(secretText), 11), {
    decision: 'error',
    reason: 'automation_failed',
    issue: 11,
  });
  const apiDiagnostic = errorDiagnostic(new GitHubApiError('GET issue API', 503, 'http_failure'), 11);
  assert.deepEqual(apiDiagnostic, {
    decision: 'error',
    reason: 'http_failure',
    operation: 'GET issue API',
    status: 503,
    issue: 11,
  });
  assert.equal(JSON.stringify(apiDiagnostic).includes(secretText), false);
});

function response(status, data, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    async json() { return data; },
  };
}

test('GitHub client exhausts native child pagination with scoped authenticated requests', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return response(200, [child(11)], {
        link: '<https://api.github.com/repos/grasdouble/Jarvis/issues/10/sub_issues?per_page=100&page=2>; rel="next"',
      });
    }
    return response(200, [child(12)]);
  };
  const client = createGitHubClient({ token: 'test-token', fetchImpl });
  assert.equal((await client.listSubIssues(10)).length, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(new URL(requests[1].url).searchParams.get('page'), '2');
});

test('GitHub client rejects repeated/cross-origin pagination and API failures', async () => {
  const repeated = '<https://api.github.com/repos/grasdouble/Jarvis/issues/10/sub_issues?per_page=100>; rel="next"';
  const loopingClient = createGitHubClient({ token: 'test-token', fetchImpl: async () => response(200, [], { link: repeated }) });
  await assert.rejects(loopingClient.listSubIssues(10), (error) => error.reason === 'pagination_loop');

  const crossOriginClient = createGitHubClient({
    token: 'test-token',
    fetchImpl: async () => response(200, [], { link: '<https://example.invalid/next>; rel="next"' }),
  });
  await assert.rejects(crossOriginClient.listSubIssues(10), (error) => error.reason === 'invalid_pagination');

  const failedClient = createGitHubClient({ token: 'test-token', fetchImpl: async () => response(503, {}) });
  await assert.rejects(
    failedClient.listSubIssues(10),
    (error) => error.reason === 'http_failure' && error.operation === 'read sub-issues' && error.status === 503,
  );

  let pages = 0;
  const pageLimitedClient = createGitHubClient({
    token: 'test-token',
    fetchImpl: async (url) => {
      pages += 1;
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      return response(200, [], {
        link: `<https://api.github.com/repos/grasdouble/Jarvis/issues/10/sub_issues?per_page=100&page=${page + 1}>; rel="next"`,
      });
    },
  });
  await assert.rejects(pageLimitedClient.listSubIssues(10), (error) => error.reason === 'page_limit_exceeded');
  assert.equal(pages, 100);
});

test('GitHub client closes only with the completed reason and verifies the response', async () => {
  let request;
  const client = createGitHubClient({
    token: 'test-token',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response(200, {
        number: 10,
        state: 'closed',
        state_reason: 'completed',
        repository_url: repositoryUrl,
      });
    },
  });
  await client.closeIssue(10);
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), { state: 'closed', state_reason: 'completed' });

  const invalidResponseClient = createGitHubClient({
    token: 'test-token',
    fetchImpl: async () => response(200, {
      number: 10,
      state: 'closed',
      state_reason: 'not_planned',
      repository_url: repositoryUrl,
    }),
  });
  await assert.rejects(invalidResponseClient.closeIssue(10), (error) => error.reason === 'invalid_response');
});
