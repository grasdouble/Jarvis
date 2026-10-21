import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessParentAcceptance,
  createAcceptanceGitHubClient,
  parseArguments,
  parseAcceptanceChecklist,
  parseAcceptanceCriteria,
  recordParentAcceptance,
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

const allValidatedAssessment = () => {
  const input = assessment();
  input.criteria[2].outcomes[0] = {
    description: 'The final child delivery is complete.',
    status: 'validated',
    kind: 'child',
    childIssues: [13],
    evidence: [
      ...evidence('https://github.com/grasdouble/Jarvis/pull/114', 'Child 13 delivery PR', 'pull_request', 'merged', 13, '7'.repeat(40), '8'.repeat(40)),
      ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/214', 'Child 13 current head checks passed', 'workflow_run', 'success', 13, '8'.repeat(40)),
    ],
  };
  return input;
};

function fakeClient(issue = parent(), childPages = children) {
  const calls = { getIssue: [], listSubIssuePages: [], listIssueComments: [], createIssueComment: [] };
  let current = structuredClone(issue);
  const comments = [];
  return {
    calls,
    comments,
    setIssue(next) { current = structuredClone(next); },
    async getIssue(number) {
      calls.getIssue.push(number);
      return structuredClone(current);
    },
    async listSubIssuePages(number) {
      calls.listSubIssuePages.push(number);
      return structuredClone(childPages);
    },
    async listIssueComments(number) {
      calls.listIssueComments.push(number);
      return structuredClone(comments);
    },
    async createIssueComment(number, commentBody) {
      calls.createIssueComment.push(number);
      comments.push({
        body: commentBody,
        user: { login: 'jarvis-development-grasdouble[bot]' },
        html_url: `https://github.com/grasdouble/Jarvis/issues/${number}#issuecomment-${comments.length + 1}`,
      });
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

test('acceptance assessment preserves parent body bytes and ignores unchecked markers', () => {
  assert.equal(parseAcceptanceCriteria(`<!-- hidden -->\n${body}`).reason, 'criteria_malformed');
  const unmanaged = assessParentAcceptance({
    parent: parent({ body: `<!-- hidden -->\n${body}` }),
    childPages: children,
    assessment: assessment(),
  });
  assert.equal(unmanaged.canRecord, false);
  assert.equal(unmanaged.reason, 'criteria_malformed');
  const report = assessParentAcceptance({ parent: parent(), childPages: children, assessment: assessment() });
  assert.deepEqual(parseAcceptanceCriteria(body), { valid: true, total: 3, unchecked: 3 });
  assert.deepEqual(report.criteria.map(item => item.status), ['validated', 'validated', 'not_yet_validated']);
  const completeAssessment = assessment();
  completeAssessment.criteria[2].outcomes[0] = {
    description: 'The final child delivery is complete.',
    status: 'validated',
    kind: 'child',
    childIssues: [13],
    evidence: [
      ...evidence('https://github.com/grasdouble/Jarvis/pull/114', 'Child 13 delivery PR', 'pull_request', 'merged', 13, '7'.repeat(40), '8'.repeat(40)),
      ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/214', 'Child 13 current head checks passed', 'workflow_run', 'success', 13, '8'.repeat(40)),
    ],
  };
  const allValidated = assessParentAcceptance({
    parent: parent(),
    childPages: [[child(11), child(12), child(13)]],
    assessment: completeAssessment,
  });
  assert.equal(allValidated.criteria.every(item => item.status === 'validated'), true);
  assert.deepEqual(parseAcceptanceCriteria(body), { valid: true, total: 3, unchecked: 3 });
});

test('parent-only evidence cannot validate criteria without accounting for every native child', () => {
  const directOnly = assessParentAcceptance({
    parent: parent(),
    childPages: children,
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
  assert.equal(directOnly.canRecord, false);
  assert.equal(directOnly.reason, 'child_outcome_coverage_incomplete');
  assert.deepEqual(directOnly.unassessedChildIssues, [11, 12, 13]);
  assert.equal(directOnly.criteria.every(item => item.status === 'unable_to_assess'), true);
});

test('a native child omitted from every parent outcome blocks recording', () => {
  const input = assessment();
  input.criteria[2].outcomes[0].childIssues = [11];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.canRecord, false);
  assert.equal(result.reason, 'child_outcome_coverage_incomplete');
  assert.deepEqual(result.unassessedChildIssues, [13]);
});

test('maps individual criteria to complete child and integrated evidence outcomes', () => {
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: assessment() });
  assert.equal(result.canRecord, true);
  assert.deepEqual(result.criteria.map(item => item.status), [
    'validated', 'validated', 'not_yet_validated',
  ]);
  assert.match(JSON.stringify(result.criteria), /Merged implementation PR/);
  assert.match(JSON.stringify(result.criteria), /reviewedRevision/);
  assert.match(JSON.stringify(result.criteria), /Disposable end-to-end fixture/);
  assert.match(JSON.stringify(result.criteria), /The required child is still open/);
});

test('one pull request and its checks cannot be reassigned to another child', () => {
  const input = assessment();
  const integration = input.criteria[1].outcomes[0];
  integration.evidence = [
    ...evidence('https://github.com/grasdouble/Jarvis/pull/111', 'Reused PR falsely labeled as child 12', 'pull_request', 'merged', 12),
    ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/211', 'Reused checks falsely labeled as child 12', 'workflow_run', 'success', 12, 'b'.repeat(40)),
    ...integration.evidence.filter(item => item.childIssue !== 12 && item.childIssue !== undefined),
    ...integration.evidence.filter(item => item.childIssue === undefined),
  ];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.canRecord, false);
  assert.equal(result.reason, 'pull_request_child_mapping_conflict');
  assert.deepEqual(result.conflictingPullRequestNumbers, [111]);
  assert.equal(result.criteria[0].status, 'unable_to_assess');
  assert.equal(result.criteria[0].reason, 'pull_request_child_mapping_conflict');
  assert.equal(result.criteria[1].status, 'unable_to_assess');
  assert.equal(result.criteria[1].reason, 'pull_request_child_mapping_conflict');
});

test('one child PR may support multiple criteria when its child mapping stays consistent', () => {
  const input = assessment();
  const integration = input.criteria[1].outcomes[0];
  integration.evidence = [
    ...integration.evidence.filter(item => item.childIssue !== 11),
    ...evidence('https://github.com/grasdouble/Jarvis/pull/111', 'Same child 11 delivery PR', 'pull_request', 'merged', 11),
    ...evidence('https://github.com/grasdouble/Jarvis/actions/runs/211', 'Same child 11 checks', 'workflow_run', 'success', 11, 'b'.repeat(40)),
  ];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.canRecord, true);
  assert.equal(result.criteria[0].status, 'validated');
  assert.equal(result.criteria[1].status, 'validated');
});

test('a completed child and a claimed outcome without delivery evidence remain unvalidated', () => {
  const input = assessment();
  input.criteria[0].outcomes[0].evidence = [];
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[0].status, 'not_yet_validated');
  assert.equal(result.criteria[0].reason, 'delivery_evidence_missing');
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
  input.criteria[1].outcomes.push({
    description: 'The other required child delivery is not yet evidenced.',
    status: 'not_yet_validated',
    kind: 'child',
    childIssues: [12],
    evidence: [],
    rationale: 'No delivery evidence is cited for child 12.',
  });
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[1].status, 'not_yet_validated');
  assert.equal(result.criteria[1].reason, 'integration_evidence_incomplete');
});

test('completed child PRs do not validate a composite criterion without an integrated result', () => {
  const input = assessment();
  input.criteria[1].outcomes[0].evidence = input.criteria[1].outcomes[0].evidence
    .filter(item => !(item.sourceType === 'workflow_run' && item.childIssue === undefined));
  const result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: input });
  assert.equal(result.criteria[1].status, 'not_yet_validated');
  assert.equal(result.criteria[1].reason, 'integration_evidence_incomplete');
});

test('a criterion text mismatch is unable to assess; an owner-authorized evolution is linked before checking', () => {
  const mismatched = assessment();
  mismatched.criteria[0].text = 'A different acceptance requirement.';
  let result = assessParentAcceptance({ parent: parent(), childPages: children, assessment: mismatched });
  assert.equal(result.criteria[0].status, 'unable_to_assess');
  assert.equal(result.criteria[0].reason, 'criterion_text_mismatch');

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
  const alignedBody = body.replace('Child-only behavior is delivered.', evolved.criteria[0].text);
  assert.equal(parseAcceptanceChecklist(body).items[0].text, 'Child-only behavior is delivered.');
  assert.equal(parseAcceptanceChecklist(alignedBody).items[0].text, evolved.criteria[0].text);
  const aligned = assessParentAcceptance({
    parent: parent({ body: alignedBody }),
    childPages: children,
    assessment: evolved,
  });
  assert.equal(aligned.criteria[0].status, 'validated');
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

test('records one comment for each completed child, then stops while another child is open', async () => {
  const client = fakeClient();
  const originalBody = (await client.getIssue(10)).body;
  const preview = await recordParentAcceptance(client, assessment());
  assert.equal(preview.decision, 'waiting_for_children');
  assert.deepEqual(preview.childDelivery.pending, [11, 12]);
  assert.equal(preview.finalAssessment.reason, 'children_incomplete');
  assert.deepEqual(client.calls.createIssueComment, []);

  const written = await recordParentAcceptance(client, assessment(), { write: true });
  assert.equal(written.decision, 'waiting_for_children');
  assert.deepEqual(written.childDelivery.recorded, [11, 12]);
  assert.equal(written.finalAssessment.recorded, false);
  assert.equal(client.comments.length, 2);
  assert.deepEqual(parseAcceptanceChecklist((await client.getIssue(10)).body).items.map(item => item.checked), [false, false, false]);
  assert.equal((await client.getIssue(10)).body, originalBody);
  assert.equal('closeIssue' in client, false);

  const replay = await recordParentAcceptance(client, assessment(), { write: true });
  assert.deepEqual(replay.childDelivery.recorded, []);
  assert.equal(client.comments.length, 2);
});

test('posts the final assessment comment only after all children close and every criterion validates', async () => {
  const completeChildren = [[child(11), child(12), child(13)]];
  const client = fakeClient(parent(), completeChildren);
  const originalBody = (await client.getIssue(10)).body;
  const result = await recordParentAcceptance(client, allValidatedAssessment(), { write: true });

  assert.equal(result.decision, 'accepted');
  assert.deepEqual(result.childDelivery.recorded, [11, 12, 13]);
  assert.equal(result.finalAssessment.recorded, true);
  assert.equal(client.comments.length, 4);
  assert.equal(client.comments.at(-1).body.includes('coordination-parent-final:v1:10'), true);
  assert.equal((await client.getIssue(10)).body, originalBody);

  const replay = await recordParentAcceptance(client, allValidatedAssessment(), { write: true });
  assert.deepEqual(replay.childDelivery.recorded, []);
  assert.equal(replay.finalAssessment.recorded, true);
  assert.equal(client.comments.length, 4);
});

test('reconciles a lost comment acknowledgement by reading back the idempotency marker', async () => {
  const completeChildren = [[child(11), child(12), child(13)]];
  const client = fakeClient(parent(), completeChildren);
  const createComment = client.createIssueComment.bind(client);
  let first = true;
  client.createIssueComment = async (...args) => {
    await createComment(...args);
    if (first) {
      first = false;
      throw new Error('synthetic lost acknowledgement after the comment was saved');
    }
  };

  const result = await recordParentAcceptance(client, allValidatedAssessment(), { write: true });
  assert.equal(result.decision, 'accepted');
  assert.equal(client.comments.length, 4);
  assert.equal(new Set(client.comments.map(comment => comment.body.match(/coordination-parent-(?:delivery|final):v1:[^ ]+/)?.[0])).size, 4);
});

test('does not publish a final assessment if the parent changes while child comments are appended', async () => {
  const completeChildren = [[child(11), child(12), child(13)]];
  const client = fakeClient(parent(), completeChildren);
  const createComment = client.createIssueComment.bind(client);
  let changed = false;
  client.createIssueComment = async (...args) => {
    await createComment(...args);
    if (!changed) {
      changed = true;
      client.setIssue(parent({ body: `${body}\nAn owner-authored concurrent note.` }));
    }
  };

  const result = await recordParentAcceptance(client, allValidatedAssessment(), { write: true });
  assert.equal(result.decision, 'unable_to_assess');
  assert.equal(result.reason, 'parent_changed_before_final_assessment');
  assert.equal(client.comments.filter(comment => comment.body.includes('coordination-parent-delivery:v1:10:')).length, 3);
  assert.equal(client.comments.some(comment => comment.body.includes('coordination-parent-final:v1:10')), false);
  assert.equal((await client.getIssue(10)).body, `${body}\nAn owner-authored concurrent note.`);
});

test('never posts a final assessment when any criterion or integrated outcome is unvalidated', async () => {
  const completeChildren = [[child(11), child(12), child(13)]];
  const input = allValidatedAssessment();
  input.criteria[1].outcomes[0].evidence = input.criteria[1].outcomes[0].evidence
    .filter(item => !(item.sourceType === 'workflow_run' && item.childIssue === undefined));
  const client = fakeClient(parent(), completeChildren);
  const result = await recordParentAcceptance(client, input, { write: true });
  assert.equal(result.decision, 'assessment_incomplete');
  assert.equal(result.finalAssessment.reason, 'criteria_not_validated');
  assert.equal(result.finalAssessment.recorded, false);
  assert.equal(client.comments.some(comment => comment.body.includes('coordination-parent-final:v1:10')), false);
  assert.equal(client.comments.filter(comment => comment.body.includes('coordination-parent-delivery:v1:10:')).length, 3);
});

test('a completed child without mapped merged PR/current-head checks gets no delivery comment', async () => {
  const completeChildren = [[child(11), child(12), child(13)]];
  const input = allValidatedAssessment();
  input.criteria[2].outcomes[0].evidence = [];
  input.criteria[2].outcomes[0].status = 'not_yet_validated';
  input.criteria[2].outcomes[0].rationale = 'No delivery evidence exists.';
  const client = fakeClient(parent(), completeChildren);
  const result = await recordParentAcceptance(client, input, { write: true });
  assert.equal(result.childDelivery.missingEvidence.includes(13), true);
  assert.equal(result.finalAssessment.recorded, false);
  assert.equal(client.comments.some(comment => comment.body.includes('delivery:v1:10:13')), false);
});

test('the GitHub adapter lists comments read-only and exposes only append-comment writes', () => {
  const calls = [];
  const runGh = (args, options = {}) => {
    calls.push({ args, write: options.write === true });
    if (args[0] === 'api' && args[1] === 'repos/grasdouble/Jarvis/issues/10') return JSON.stringify(parent());
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'GET'
      && args.at(-1).includes('/sub_issues?')) return JSON.stringify(children);
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'GET'
      && args.at(-1).includes('/comments?')) return JSON.stringify([[]]);
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') return '{}';
    throw new Error('Unexpected command.');
  };
  const readOnlyClient = createAcceptanceGitHubClient(runGh);
  assert.equal('createIssueComment' in readOnlyClient, false);
  assert.equal('updateIssueBody' in readOnlyClient, false);

  const client = createAcceptanceGitHubClient(runGh, { writeEnabled: true });
  assert.equal(client.getIssue(10).number, 10);
  assert.deepEqual(client.listSubIssuePages(10), children);
  assert.deepEqual(client.listIssueComments(10), []);
  client.createIssueComment(10, 'append-only');
  assert.deepEqual(calls.map(call => call.write), [false, false, false, true]);
  assert.equal(calls.some(call => call.args.includes('PATCH')), false);
  assert.equal('closeIssue' in client, false);
});

test('CLI uses explicit append-comment write mode without body-edit confirmation', () => {
  assert.deepEqual(parseArguments(['10', 'assessment.json']), {
    issueNumber: 10,
    assessmentFile: 'assessment.json',
    write: false,
  });
  assert.deepEqual(parseArguments([
    '10', 'assessment.json', '--write',
  ]), {
    issueNumber: 10,
    assessmentFile: 'assessment.json',
    write: true,
  });
  assert.throws(() => parseArguments(['10', 'assessment.json', '--confirm-exclusive-body-edit']), /Usage/);
});
