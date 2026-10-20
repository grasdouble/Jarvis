import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessParentAcceptance,
  createAcceptanceGitHubClient,
  parseAcceptanceChecklist,
  parseAcceptanceCriteria,
  recordParentAcceptance,
  updateAcceptanceBody,
} from './coordination-parent-acceptance.mjs';

const repositoryUrl = 'https://api.github.com/repos/grasdouble/Jarvis';
const body = `## Outcome
Coordinate several deliveries.

## Acceptance criteria
- [ ] Child-only behavior is delivered.
- [ ] Cross-child workflow works end to end.
- [ ] Scope wording remains the accepted contract.

## Notes
Keep this context.`;

const parent = (overrides = {}) => ({
  number: 10,
  state: 'open',
  state_reason: null,
  body,
  repository_url: repositoryUrl,
  sub_issues_summary: { total: 3 },
  ...overrides,
});

const child = (number, overrides = {}) => ({
  number,
  state: 'closed',
  state_reason: 'completed',
  repository_url: repositoryUrl,
  ...overrides,
});

const children = [[child(11), child(12), child(13, { state: 'open', state_reason: null })]];
const evidence = (url, label, sourceType = 'pull_request', status = 'merged', childIssue = null, revision = 'a'.repeat(40), reviewedRevision = 'b'.repeat(40)) => [{
  url,
  label,
  sourceType,
  status,
  ...(['pull_request', 'workflow_run', 'commit'].includes(sourceType) ? { revision } : {}),
  ...(sourceType === 'pull_request' ? { reviewedRevision } : {}),
  ...(childIssue === null ? {} : { childIssue }),
}];

const assessment = overrides => ({
  parentIssue: 10,
  criteria: [
    {
      index: 1,
      text: 'Child-only behavior is delivered.',
      outcomes: [{
        description: 'The child delivered the independent behavior.',
        status: 'validated',
        kind: 'child',
        childIssues: [11],
        evidence: [
          ...evidence('https://github.com/grasdouble/Jarvis/pull/111', 'Merged implementation PR', 'pull_request', 'merged', 11),
          ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/211', 'Current head checks passed', 'workflow_run', 'success', 11, 'b'.repeat(40)),
        ],
      }],
    },
    {
      index: 2,
      text: 'Cross-child workflow works end to end.',
      outcomes: [{
        description: 'The integrated workflow covers both deliveries.',
        status: 'validated',
        kind: 'integration',
        childIssues: [11, 12],
        evidence: [
          ...evidence('https://github.com/grasdouble/Jarvis/pull/112', 'Child 12 delivery PR', 'pull_request', 'merged', 12, 'c'.repeat(40), 'd'.repeat(40)),
          ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/212', 'Child 12 current head checks passed', 'workflow_run', 'success', 12, 'd'.repeat(40)),
          ...evidence('https://github.com/grasdouble/Jarvis/pull/113', 'Child 11 delivery PR', 'pull_request', 'merged', 11, 'e'.repeat(40), 'f'.repeat(40)),
          ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/213', 'Child 11 current head checks passed', 'workflow_run', 'success', 11, 'f'.repeat(40)),
          ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/222', 'Disposable end-to-end fixture', 'workflow_run', 'success', null, '9'.repeat(40)),
        ],
      }],
    },
    {
      index: 3,
      text: 'Scope wording remains the accepted contract.',
      outcomes: [{
        description: 'The remaining child delivery is not complete.',
        status: 'not_yet_validated',
        kind: 'child',
        childIssues: [13],
        evidence: [],
        rationale: 'The required child is still open.',
      }],
    },
  ],
  ...overrides,
});

function fakeClient(issue = parent(), childPages = children) {
  const calls = { getIssue: [], listSubIssuePages: [], updateIssueBody: [] };
  let current = structuredClone(issue);
  return {
    calls,
    async getIssue(number) {
      calls.getIssue.push(number);
      return structuredClone(current);
    },
    async listSubIssuePages(number) {
      calls.listSubIssuePages.push(number);
      return structuredClone(childPages);
    },
    async updateIssueBody(number, nextBody) {
      calls.updateIssueBody.push(number);
      current = { ...current, body: nextBody };
    },
  };
}

test('parses exact criterion text and positions without counting fenced examples', () => {
  const parsed = parseAcceptanceChecklist(`${body}\n\n~~~md\n## Acceptance criteria\n- [x] example\n~~~`);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.items.map(item => ({ index: item.index, text: item.text, checked: item.checked })), [
    { index: 1, text: 'Child-only behavior is delivered.', checked: false },
    { index: 2, text: 'Cross-child workflow works end to end.', checked: false },
    { index: 3, text: 'Scope wording remains the accepted contract.', checked: false },
  ]);
});

test('the structural check still rejects unmanaged comments but accepts its owned evidence block', () => {
  assert.equal(parseAcceptanceCriteria(`<!-- hidden -->\n${body}`).reason, 'criteria_malformed');
  const unmanaged = assessParentAcceptance({
    parent: parent({ body: `<!-- hidden -->\n${body}` }),
    childPages: children,
    assessment: assessment(),
  });
  assert.equal(unmanaged.canRecord, false);
  assert.equal(unmanaged.reason, 'criteria_malformed');
  const report = assessParentAcceptance({ parent: parent(), childPages: children, assessment: assessment() });
  const recordedBody = updateAcceptanceBody(body, report);
  assert.deepEqual(parseAcceptanceCriteria(recordedBody), { valid: false, total: 3, unchecked: 1, reason: 'criteria_unchecked' });
  const allValidated = assessParentAcceptance({
    parent: parent({ sub_issues_summary: { total: 2 } }),
    childPages: [[child(11), child(12)]],
    assessment: {
      parentIssue: 10,
      criteria: [1, 2, 3].map(index => ({
        index,
        text: parseAcceptanceChecklist(body).items[index - 1].text,
        outcomes: [{
          description: `Criterion ${index} is directly demonstrated.`,
          status: 'validated',
          kind: 'direct',
          childIssues: [],
          evidence: evidence(`https://github.com/grasdouble/Jarvis/releases/tag/v${index}`, 'Published verification fixture', 'release', 'published'),
        }],
      })),
    },
  });
  assert.equal(allValidated.criteria.every(item => item.status === 'validated'), true);
  const fullyChecked = updateAcceptanceBody(body, allValidated);
  assert.equal(parseAcceptanceCriteria(fullyChecked).valid, true);
});

test('maps individual criteria to complete child and integrated evidence outcomes', () => {
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: assessment() });
  assert.equal(result.canRecord, true);
  assert.deepEqual(result.criteria.map(item => item.status), [
    'validated', 'validated', 'not_yet_validated',
  ]);
  const nextBody = updateAcceptanceBody(body, result);
  assert.deepEqual(parseAcceptanceChecklist(nextBody).items.map(item => item.checked), [true, true, false]);
  assert.match(nextBody, /Merged implementation PR/);
  assert.match(nextBody, /reviewed head b{40}/);
  assert.match(nextBody, /Disposable end-to-end fixture/);
  assert.match(nextBody, /workflow\\_run; success; revision b{40}/);
  assert.match(nextBody, /The required child is still open\./);
});

test('records evidence safely when Acceptance criteria is the final section and is idempotent', () => {
  const bareBody = '## Acceptance criteria\n- [ ] Direct behavior is proven.';
  const bareParent = parent({ body: bareBody, sub_issues_summary: { total: 1 } });
  const input = {
    parentIssue: 10,
    criteria: [{
      index: 1,
      text: 'Direct behavior is proven.',
      outcomes: [{
        description: 'The child behavior is proven by the merged implementation.',
        status: 'validated',
        kind: 'child',
        childIssues: [11],
        evidence: [
          ...evidence('https://github.com/grasdouble/Jarvis/pull/111', 'Merged PR', 'pull_request', 'merged', 11),
          ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/211', 'Current head checks', 'workflow_run', 'success', 11, 'b'.repeat(40)),
        ],
      }],
    }],
  };
  const result = assessParentAcceptance({ parent: bareParent, childPages: [[child(11)]], assessment: input });
  const nextBody = updateAcceptanceBody(bareBody, result);
  assert.equal(parseAcceptanceChecklist(nextBody).valid, true);
  assert.equal(parseAcceptanceChecklist(nextBody).items[0].checked, true);
  assert.equal(updateAcceptanceBody(nextBody, result), nextBody);
  assert.throws(
    () => updateAcceptanceBody(`${bareBody}\n\n## Parent acceptance assessment evidence\nManual notes.`, result),
    /unmanaged parent acceptance evidence heading/,
  );
});

test('a completed child and a claimed outcome without delivery evidence remain unchecked', () => {
  const input = assessment();
  input.criteria[0].outcomes[0].evidence = [];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[0].status, 'not_yet_validated');
  assert.equal(result.criteria[0].reason, 'delivery_evidence_missing');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[0].checked, false);
});

test('an open linked PR cannot support a validated child outcome', () => {
  const input = assessment();
  input.criteria[0].outcomes[0].evidence = evidence(
    'https://github.com/grasdouble/Jarvis/pull/111',
    'The linked delivery PR is not merged.',
    'pull_request',
    'open',
    11,
  );
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[0].status, 'not_yet_validated');
  assert.equal(result.criteria[0].reason, 'delivery_pr_not_merged');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[0].checked, false);
});

test('an incomplete cross-child outcome is not validated even when one completed child is cited', () => {
  const input = assessment();
  input.criteria[1].outcomes[0].childIssues = [11];
  input.criteria[1].outcomes[0].evidence = evidence(
    'https://github.com/grasdouble/Jarvis/actions/runs/222',
    'No cross-child fixture has been run.',
    'workflow_run',
    'success',
  );
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[1].status, 'not_yet_validated');
  assert.equal(result.criteria[1].reason, 'integration_evidence_incomplete');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[1].checked, false);
});

test('completed child PRs do not validate a composite criterion without an integrated result', () => {
  const input = assessment();
  input.criteria[1].outcomes[0].evidence = input.criteria[1].outcomes[0].evidence
    .filter(item => !(item.sourceType === 'workflow_run' && item.childIssue === undefined));
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[1].status, 'not_yet_validated');
  assert.equal(result.criteria[1].reason, 'integration_evidence_incomplete');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[1].checked, false);
});

test('a criterion text mismatch is unable to assess; an owner-authorized evolution is linked before checking', () => {
  const mismatched = assessment();
  mismatched.criteria[0].text = 'A different acceptance requirement.';
  let result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: mismatched });
  assert.equal(result.criteria[0].status, 'unable_to_assess');
  assert.equal(result.criteria[0].reason, 'criterion_text_mismatch');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[0].checked, false);

  const evolved = assessment();
  evolved.criteria[0].text = 'The trusted writer delivers the approved behavior.';
  evolved.criteria[0].scopeEvolution = {
    previousText: 'Child-only behavior is delivered.',
    authorizationUrl: 'https://github.com/grasdouble/Jarvis/issues/9#issuecomment-9001',
    rationale: 'The owner approved this scoped replacement.',
  };
  result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: evolved });
  assert.equal(result.criteria[0].status, 'not_yet_validated');
  assert.equal(result.criteria[0].reason, 'criterion_scope_alignment_required');
  const nextBody = updateAcceptanceBody(body, result);
  assert.equal(parseAcceptanceChecklist(nextBody).items[0].text, evolved.criteria[0].text);
  assert.equal(parseAcceptanceChecklist(nextBody).items[0].checked, false);
  assert.match(nextBody, /issuecomment-9001/);
  const aligned = assessParentAcceptance({
    parent: parent({ body: nextBody }),
    childPages: children,
    assessment: evolved,
  });
  assert.equal(aligned.criteria[0].status, 'validated');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(nextBody, aligned)).items[0].checked, true);
});

test('a merged PR without a successful current-head check remains unchecked', () => {
  const input = assessment();
  input.criteria[0].outcomes[0].evidence = evidence(
    'https://github.com/grasdouble/Jarvis/pull/111',
    'Merged implementation PR only.',
    'pull_request',
    'merged',
    11,
  );
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[0].status, 'not_yet_validated');
  assert.equal(result.criteria[0].reason, 'current_head_check_missing');
  assert.equal(parseAcceptanceChecklist(updateAcceptanceBody(body, result)).items[0].checked, false);
});

test('a successful commit check linked to the reviewed PR head supports the child outcome', () => {
  const input = assessment();
  input.criteria[0].outcomes[0].evidence = [
    ...input.criteria[0].outcomes[0].evidence.filter(item => item.sourceType !== 'workflow_run'),
    {
      url: `https://github.com/grasdouble/Jarvis/commit/${'b'.repeat(40)}/checks`,
      label: 'Required head checks passed.',
      sourceType: 'check_run',
      status: 'success',
      revision: 'b'.repeat(40),
      childIssue: 11,
    },
  ];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[0].status, 'validated');
  assert.equal(result.criteria[0].outcomes[0].evidence[1].sourceType, 'check_run');
});

test('incomplete or malformed native child inventory cannot be recorded', () => {
  const result = assessParentAcceptance({
    parent: parent(),
    childPages: [[child(11)]],
    assessment: assessment(),
  });
  assert.equal(result.canRecord, false);
  assert.equal(result.decision, 'unable_to_assess');
});

test('an issue without native children is not treated as a coordination parent', () => {
  const result = assessParentAcceptance({
    parent: parent({ sub_issues_summary: { total: 0 } }),
    childPages: [[]],
    assessment: assessment(),
  });
  assert.equal(result.canRecord, false);
  assert.equal(result.reason, 'no_native_children');
});

test('preview is read-only and an explicit write records only supported boxes without closing the parent', async () => {
  const client = fakeClient();
  const preview = await recordParentAcceptance(client, assessment());
  assert.equal(preview.recorded, false);
  assert.equal(preview.wouldChange, true);
  assert.equal(preview.criteria[0].outcomes[0].evidence[0].url, 'https://github.com/grasdouble/Jarvis/pull/111');
  assert.deepEqual(client.calls.updateIssueBody, []);

  const recorded = await recordParentAcceptance(client, assessment(), { write: true });
  assert.equal(recorded.recorded, true);
  assert.deepEqual(client.calls.updateIssueBody, [10]);
  assert.deepEqual(parseAcceptanceChecklist((await client.getIssue(10)).body).items.map(item => item.checked), [true, true, false]);
  assert.equal('closeIssue' in client, false);

  const replay = await recordParentAcceptance(client, assessment(), { write: true });
  assert.equal(replay.recorded, true);
  assert.equal(replay.wouldChange, false);
  assert.deepEqual(client.calls.updateIssueBody, [10]);
});

test('a concurrent parent-body edit is detected before the authorized write', async () => {
  const calls = { getIssue: 0, updateIssueBody: [] };
  const client = {
    async getIssue() {
      calls.getIssue += 1;
      return parent({ body: calls.getIssue === 1 ? body : `${body}\nA concurrent note.` });
    },
    async listSubIssuePages() {
      return structuredClone(children);
    },
    async updateIssueBody(number) {
      calls.updateIssueBody.push(number);
    },
  };
  const result = await recordParentAcceptance(client, assessment(), { write: true });
  assert.equal(result.canRecord, false);
  assert.equal(result.reason, 'parent_changed_before_write');
  assert.deepEqual(result.criteria, []);
  assert.deepEqual(calls.updateIssueBody, []);
});

test('the GitHub adapter uses read mode by default and enables writes only for an explicit writer', () => {
  const calls = [];
  const runGh = (args, options = {}) => {
    calls.push({ args, write: options.write === true });
    if (args[0] === 'api' && args[1] === 'repos/grasdouble/Jarvis/issues/10') return JSON.stringify(parent());
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'GET') return JSON.stringify(children);
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') return JSON.stringify(parent());
    throw new Error('Unexpected command.');
  };
  const readOnlyClient = createAcceptanceGitHubClient(runGh);
  assert.equal('updateIssueBody' in readOnlyClient, false);

  const client = createAcceptanceGitHubClient(runGh, { writeEnabled: true });
  assert.equal(client.getIssue(10).number, 10);
  assert.deepEqual(client.listSubIssuePages(10), children);
  client.updateIssueBody(10, 'new body');
  assert.deepEqual(calls.map(call => call.write), [false, false, true]);
  assert.equal('closeIssue' in client, false);
});
