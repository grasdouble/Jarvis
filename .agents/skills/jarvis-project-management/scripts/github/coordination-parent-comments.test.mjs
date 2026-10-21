import assert from 'node:assert/strict';
import test from 'node:test';
import {
  childDeliveryMarker,
  indexCoordinationParentComments,
  parseChildDeliveryComment,
  parseFinalAssessmentComment,
  renderChildDeliveryComment,
  renderFinalAssessmentComment,
} from './coordination-parent-comments.mjs';

const app = 'jarvis-development-grasdouble[bot]';
const childIssues = [11, 12];
const criteria = [
  { index: 1, text: 'Child behavior is delivered.' },
  { index: 2, text: 'The cross-child integration passes.' },
];
const pr11 = {
  url: 'https://github.com/grasdouble/Jarvis/pull/111', label: 'Child 11 merged PR',
  sourceType: 'pull_request', status: 'merged', revision: 'a'.repeat(40),
  reviewedRevision: 'b'.repeat(40), childIssue: 11,
};
const check11 = {
  url: `https://github.com/grasdouble/Jarvis/commit/${'b'.repeat(40)}/checks`,
  label: 'Child 11 head checks', sourceType: 'check_run', status: 'success',
  revision: 'b'.repeat(40), childIssue: 11,
};
const pr12 = {
  url: 'https://github.com/grasdouble/Jarvis/pull/112', label: 'Child 12 merged PR',
  sourceType: 'pull_request', status: 'merged', revision: 'c'.repeat(40),
  reviewedRevision: 'd'.repeat(40), childIssue: 12,
};
const check12 = {
  url: 'https://github.com/grasdouble/Jarvis/actions/runs/212',
  label: 'Child 12 head checks', sourceType: 'workflow_run', status: 'success',
  revision: 'd'.repeat(40), childIssue: 12,
};
const integration = {
  url: 'https://github.com/grasdouble/Jarvis/actions/runs/222',
  label: 'Cross-child rehearsal', sourceType: 'workflow_run', status: 'success',
  revision: 'e'.repeat(40),
};
const issueCommentEvidence = {
  url: 'https://github.com/grasdouble/Jarvis/issues/10#issuecomment-555',
  label: 'Owner-approved fixture source', sourceType: 'issue_comment', status: 'available',
};

function delivery(childIssue, pr, check) {
  return {
    schemaVersion: 1,
    parentIssue: 10,
    childIssue,
    state: 'closed',
    stateReason: 'completed',
    evidence: [pr, check],
  };
}

function finalAssessment(overrides = {}) {
  return {
    parentIssue: 10,
    childCount: 2,
    criteria: [
      {
        index: 1,
        text: criteria[0].text,
        status: 'validated',
        outcomes: [{
          description: 'Child 11 delivered the required behavior.',
          kind: 'child',
          status: 'validated',
          childIssues: [11],
          evidence: [pr11, check11],
        }],
      },
      {
        index: 2,
        text: criteria[1].text,
        status: 'validated',
        outcomes: [{
          description: 'The cross-child rehearsal passed.',
          kind: 'integration',
          status: 'validated',
          childIssues: [11, 12],
          evidence: [pr11, check11, pr12, check12, integration, issueCommentEvidence],
        }],
      },
    ],
    ...overrides,
  };
}

function appComment(body) {
  return { body, user: { login: app } };
}

test('renders and parses a child-delivery comment with merged PR and matching head checks', () => {
  const record = delivery(11, pr11, check11);
  const body = renderChildDeliveryComment(record);
  assert.match(body, /CLOSED \/ COMPLETED/);
  assert.match(body, /pull\/111/);
  assert.match(body, /commit\/b{40}\/checks/);
  assert.deepEqual(parseChildDeliveryComment(appComment(body), 10, 11), record);
  assert.equal(parseChildDeliveryComment(appComment(body), 10, 12), null);
  const untrusted = appComment(body);
  untrusted.user.login = 'other-user';
  assert.equal(parseChildDeliveryComment(untrusted, 10, 11), null);
});

test('refuses delivery records without the exact successful current-head check', () => {
  const staleCheck = { ...check11, revision: 'c'.repeat(40) };
  assert.throws(() => renderChildDeliveryComment(delivery(11, pr11, staleCheck)), /invalid child-delivery/);
  assert.throws(() => renderChildDeliveryComment({ ...delivery(11, pr11, check11), stateReason: 'not_planned' }), /invalid child-delivery/);
});

test('renders only a fully validated final report and parses it against exact current criteria', () => {
  const report = finalAssessment();
  report.criteria[0].scopeEvolution = {
    previousText: 'Previous wording.',
    authorizationUrl: 'https://github.com/grasdouble/Jarvis/issues/10#issuecomment-554',
    rationale: 'The owner explicitly approved the replacement.',
  };
  const body = renderFinalAssessmentComment(report);
  const comment = appComment(body);
  assert.match(body, /Every acceptance criterion is validated/);
  assert.match(body, /Authorized wording evolution/);
  assert.match(body, /issuecomment-554/);
  assert.match(body, /Owner-approved fixture source/);
  assert.doesNotMatch(body, /undefined/);
  const parsed = parseFinalAssessmentComment(comment, { parentIssue: 10, criteria, childIssues });
  assert.equal(parsed.parentIssue, 10);
  assert.equal(parsed.childCount, 2);
  assert.equal(parsed.criteria.length, 2);
  assert.equal(parsed.criteria[0].text, criteria[0].text);
  assert.equal(parseFinalAssessmentComment(comment, {
    parentIssue: 10,
    criteria: [{ ...criteria[0], text: 'Reworded criterion.' }, criteria[1]],
    childIssues,
  }), null);
  assert.throws(() => renderFinalAssessmentComment(finalAssessment({
    criteria: finalAssessment().criteria.map((criterion, index) => index === 0
      ? { ...criterion, status: 'not_yet_validated' }
      : criterion),
  })), /every criterion is validated/);
});

test('rejects non-integrated composite outcomes and inconsistent PR-to-child mappings', () => {
  const noIntegration = finalAssessment();
  noIntegration.criteria[1].outcomes[0].evidence = [pr11, check11, pr12, check12];
  assert.throws(() => renderFinalAssessmentComment(noIntegration), /validated child and integration evidence/);

  const conflict = finalAssessment();
  conflict.criteria[1].outcomes[0].evidence = [
    ...conflict.criteria[1].outcomes[0].evidence,
    { ...pr11, childIssue: 12 },
  ];
  assert.throws(() => renderFinalAssessmentComment(conflict), /conflicting PR-to-child mappings/);
});

test('structural inventory requires one matching child comment for every child and one exact final comment', () => {
  const delivery11 = appComment(renderChildDeliveryComment(delivery(11, pr11, check11)));
  const delivery12 = appComment(renderChildDeliveryComment(delivery(12, pr12, check12)));
  const final = appComment(renderFinalAssessmentComment(finalAssessment()));
  assert.equal(indexCoordinationParentComments([delivery11, delivery12, final], {
    parentIssue: 10, criteria, childIssues,
  }).valid, true);
  assert.equal(indexCoordinationParentComments([delivery11, final], {
    parentIssue: 10, criteria, childIssues,
  }).reason, 'child_delivery_comment_missing');
  assert.equal(indexCoordinationParentComments([delivery11, delivery12], {
    parentIssue: 10, criteria, childIssues,
  }).reason, 'final_assessment_missing');
  assert.equal(indexCoordinationParentComments([delivery11, delivery12, final, final], {
    parentIssue: 10, criteria, childIssues,
  }).reason, 'final_assessment_invalid');
});

test('final report child evidence must agree with the append-only delivery records', () => {
  const delivery11 = appComment(renderChildDeliveryComment(delivery(11, pr11, check11)));
  const delivery12 = appComment(renderChildDeliveryComment(delivery(12, pr12, check12)));
  const finalInput = finalAssessment();
  finalInput.criteria[0].outcomes[0].evidence[0] = { ...pr11, url: 'https://github.com/grasdouble/Jarvis/pull/999' };
  const final = appComment(renderFinalAssessmentComment(finalInput));
  assert.equal(indexCoordinationParentComments([delivery11, delivery12, final], {
    parentIssue: 10, criteria, childIssues,
  }).reason, 'final_assessment_invalid');
  assert.equal(childDeliveryMarker(10, 11), '<!-- jarvis:coordination-parent-delivery:v1:10:11 -->');
});
