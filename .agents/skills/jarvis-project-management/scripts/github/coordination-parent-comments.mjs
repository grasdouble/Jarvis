import { createHash } from 'node:crypto';

const APP_AUTHOR = 'jarvis-development-grasdouble[bot]';
const DATA_LINE = /^<!-- jarvis:coordination-parent-data:v1:([A-Za-z0-9_-]+) -->$/;
const DELIVERY_MARKER = parentIssue => `<!-- jarvis:coordination-parent-delivery:v2:${parentIssue}:`;
const LEGACY_DELIVERY_MARKER = parentIssue => `<!-- jarvis:coordination-parent-delivery:v1:${parentIssue}:`;
const FINAL_MARKER = parentIssue => `<!-- jarvis:coordination-parent-final:v1:${parentIssue} -->`;
const DELIVERY_EVIDENCE_STATUSES = new Set(['validated', 'not_yet_validated']);
const DELIVERY_EVIDENCE_REASONS = new Set([
  'delivery_evidence_missing',
  'delivery_pr_missing',
  'delivery_pr_not_merged',
  'delivery_evidence_not_successful',
  'current_head_check_missing',
]);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIssueNumber = value => Number.isSafeInteger(value) && value > 0;
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

function markdownText(value) {
  const special = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '!', '<', '>', '|']);
  return [...String(value).replace(/\s+/g, ' ').trim()]
    .map(character => special.has(character) ? `\\${character}` : character)
    .join('');
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function commentLines(comment) {
  return typeof comment?.body === 'string' ? comment.body.split(/\r?\n/) : [];
}

function decodePayload(comment, expectedMarker) {
  if (!isObject(comment) || comment.user?.login !== APP_AUTHOR) return null;
  const lines = commentLines(comment);
  const markers = lines.filter(line => line === expectedMarker);
  const data = lines.filter(line => DATA_LINE.test(line));
  if (markers.length !== 1 || data.length !== 1) return null;
  const encoded = data[0].match(DATA_LINE)?.[1];
  if (!encoded) return null;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== encoded) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function validJarvisUrl(value) {
  if (typeof value !== 'string' || /\s|[<>]/.test(value)
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      && url.pathname.toLowerCase().startsWith('/grasdouble/jarvis/')
      && url.search === '' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function pullRequestNumber(urlValue) {
  if (typeof urlValue !== 'string') return null;
  try {
    const match = new URL(urlValue).pathname.toLowerCase().match(/^\/grasdouble\/jarvis\/pull\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function deliveryEvidenceDigest(payload) {
  const canonical = {
    schemaVersion: payload.schemaVersion,
    parentIssue: payload.parentIssue,
    childIssue: payload.childIssue,
    state: payload.state,
    stateReason: payload.stateReason,
    evidenceStatus: payload.evidenceStatus,
    reason: payload.reason ?? null,
    evidence: payload.evidence,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validDeliveryEvidence(evidence, childIssue, evidenceStatus, reason) {
  if (!Array.isArray(evidence) || !DELIVERY_EVIDENCE_STATUSES.has(evidenceStatus)) return false;
  if (evidenceStatus === 'validated' && reason !== null && reason !== undefined) return false;
  if (evidenceStatus === 'not_yet_validated' && !DELIVERY_EVIDENCE_REASONS.has(reason)) return false;
  const pullRequests = evidence.filter(item => item?.sourceType === 'pull_request');
  const checks = evidence.filter(item => ['workflow_run', 'check_run'].includes(item?.sourceType));
  if (pullRequests.length + checks.length !== evidence.length) return false;
  const pullRequestNumbers = new Set();
  for (const pr of pullRequests) {
    const number = pullRequestNumber(pr.url);
    if (!validJarvisUrl(pr.url) || number === null || pullRequestNumbers.has(number)
      || !['merged', 'open', 'closed'].includes(pr.status) || pr.childIssue !== childIssue
      || !isSha(pr.revision) || !isSha(pr.reviewedRevision) || typeof pr.label !== 'string' || !pr.label.trim()) return false;
    pullRequestNumbers.add(number);
    if (evidenceStatus === 'validated' && (pr.status !== 'merged' || !checks.some(check => check.status === 'success'
      && check.childIssue === childIssue
      && check.revision?.toLowerCase() === pr.reviewedRevision.toLowerCase()))) return false;
  }
  for (const check of checks) {
    if (!validJarvisUrl(check.url) || !['success', 'failure', 'skipped', 'in_progress'].includes(check.status)
      || check.childIssue !== childIssue
      || !isSha(check.revision) || typeof check.label !== 'string' || !check.label.trim()) return false;
    if (check.sourceType === 'workflow_run' && !/^\/grasdouble\/jarvis\/actions\/runs\/\d+$/.test(new URL(check.url).pathname.toLowerCase())) return false;
    if (check.sourceType === 'check_run'
      && !new RegExp(`^/grasdouble/jarvis/commit/${check.revision.toLowerCase()}(?:/checks)?$`).test(new URL(check.url).pathname.toLowerCase())) return false;
  }
  if (evidenceStatus === 'validated' && (pullRequests.length === 0
    || evidence.some(item => item.status !== (item.sourceType === 'pull_request' ? 'merged' : 'success')))) return false;
  return true;
}

function renderEvidence(evidence) {
  return evidence.map(item => {
    const revision = item.sourceType === 'pull_request'
      ? `merge ${item.revision}; reviewed head ${item.reviewedRevision}`
      : item.revision ? `revision ${item.revision}` : null;
    const details = [item.sourceType, item.status, ...(revision ? [revision] : [])].join('; ');
    return `- **${markdownText(item.label)}** (${details}) — <${item.url}>`;
  });
}

export function childDeliveryMarker(parentIssue, childIssue, payload) {
  if (!isIssueNumber(parentIssue) || !isIssueNumber(childIssue)
    || payload?.parentIssue !== parentIssue || payload?.childIssue !== childIssue) {
    throw new Error('A matching delivery payload is required to derive its marker.');
  }
  return `${DELIVERY_MARKER(parentIssue)}${childIssue}:${deliveryEvidenceDigest(payload)} -->`;
}

export function childDeliveryMarkerPrefix(parentIssue, childIssue) {
  return `${DELIVERY_MARKER(parentIssue)}${childIssue}:`;
}

export function legacyChildDeliveryMarkerPrefix(parentIssue) {
  return LEGACY_DELIVERY_MARKER(parentIssue);
}

export function finalAssessmentMarker(parentIssue) {
  return FINAL_MARKER(parentIssue);
}

export function renderChildDeliveryComment(payload) {
  const { parentIssue, childIssue, evidence, evidenceStatus, reason } = payload ?? {};
  if (!isIssueNumber(parentIssue) || !isIssueNumber(childIssue)
    || payload?.schemaVersion !== 2 || payload.state !== 'closed' || payload.stateReason !== 'completed'
    || !validDeliveryEvidence(evidence, childIssue, evidenceStatus, reason)) {
    throw new Error('Cannot render an invalid child-delivery record.');
  }
  const normalized = {
    schemaVersion: 2,
    parentIssue,
    childIssue,
    state: 'closed',
    stateReason: 'completed',
    evidenceStatus,
    reason: reason ?? null,
    evidence,
  };
  return [
    childDeliveryMarker(parentIssue, childIssue, normalized),
    `<!-- jarvis:coordination-parent-data:v1:${encodePayload(normalized)} -->`,
    `## Child delivery evidence — #${childIssue}`,
    `Parent: #${parentIssue}. Child state: **CLOSED / COMPLETED**.`,
    `Evidence status: **${evidenceStatus === 'validated' ? 'validated' : 'not yet validated'}**${reason ? `; reason: \`${reason}\`` : ''}.`,
    '',
    ...(evidence.length > 0 ? renderEvidence(evidence) : ['No linked pull request or check evidence was supplied.']),
  ].join('\n');
}

export function parseChildDeliveryComment(comment, parentIssue, childIssue) {
  const markerPrefix = childDeliveryMarkerPrefix(parentIssue, childIssue);
  const markers = commentLines(comment).filter(line => line.startsWith(markerPrefix));
  if (markers.length !== 1 || !/^<!-- jarvis:coordination-parent-delivery:v2:\d+:\d+:[0-9a-f]{64} -->$/.test(markers[0])) return null;
  const payload = decodePayload(comment, markers[0]);
  if (!isObject(payload) || payload.schemaVersion !== 2 || payload.parentIssue !== parentIssue
    || payload.childIssue !== childIssue || payload.state !== 'closed' || payload.stateReason !== 'completed'
    || !validDeliveryEvidence(payload.evidence, childIssue, payload.evidenceStatus, payload.reason)) return null;
  if (markers[0] !== childDeliveryMarker(parentIssue, childIssue, payload)) return null;
  if (comment.body !== renderChildDeliveryComment(payload)) return null;
  return payload;
}

function validSerializedEvidence(source, childIssues, { integration = false } = {}) {
  if (!isObject(source) || !validJarvisUrl(source.url) || typeof source.label !== 'string' || !source.label.trim()) return false;
  if (source.childIssue !== undefined && !childIssues.includes(source.childIssue)) return false;
  if (source.sourceType === 'pull_request') {
    return source.status === 'merged' && childIssues.includes(source.childIssue)
      && isSha(source.revision) && isSha(source.reviewedRevision)
      && pullRequestNumber(source.url) !== null;
  }
  if (['workflow_run', 'check_run'].includes(source.sourceType)) {
    if (source.status !== 'success' || !isSha(source.revision)) return false;
    if (source.childIssue === undefined) {
      return integration && source.sourceType === 'workflow_run'
        && /^\/grasdouble\/jarvis\/actions\/runs\/\d+$/.test(new URL(source.url).pathname.toLowerCase());
    }
    if (!childIssues.includes(source.childIssue)) return false;
    if (source.sourceType === 'workflow_run') {
      return /^\/grasdouble\/jarvis\/actions\/runs\/\d+$/.test(new URL(source.url).pathname.toLowerCase());
    }
    return new RegExp(`^/grasdouble/jarvis/commit/${source.revision.toLowerCase()}(?:/checks)?$`)
      .test(new URL(source.url).pathname.toLowerCase());
  }
  if (source.sourceType === 'commit') {
    return source.status === 'present' && isSha(source.revision)
      && new RegExp(`^/grasdouble/jarvis/commit/${source.revision.toLowerCase()}$`)
        .test(new URL(source.url).pathname.toLowerCase());
  }
  if (source.sourceType === 'release') {
    return source.status === 'published'
      && /^\/grasdouble\/jarvis\/releases\/tag\/.+$/.test(new URL(source.url).pathname.toLowerCase());
  }
  if (source.sourceType === 'issue_comment') {
    return source.status === 'available'
      && /^\/grasdouble\/jarvis\/(?:issues|pull)\/\d+$/.test(new URL(source.url).pathname.toLowerCase())
      && /^#(?:issuecomment-\d+|discussion_r\d+)$/i.test(new URL(source.url).hash);
  }
  if (source.sourceType === 'other') return source.status === 'verified';
  return false;
}

function validSerializedOutcome(outcome, nativeChildren) {
  if (!isObject(outcome) || outcome.status !== 'validated' || typeof outcome.description !== 'string'
    || !outcome.description.trim() || !['child', 'integration'].includes(outcome.kind)
    || !Array.isArray(outcome.childIssues) || outcome.childIssues.length === 0
    || new Set(outcome.childIssues).size !== outcome.childIssues.length
    || !outcome.childIssues.every(isIssueNumber)
    || !outcome.childIssues.every(number => nativeChildren.has(number)) || !Array.isArray(outcome.evidence)) return false;
  if (outcome.kind === 'child' && outcome.childIssues.length !== 1) return false;
  if (outcome.kind === 'integration' && outcome.childIssues.length < 2) return false;
  if (outcome.evidence.some(source => !validSerializedEvidence(source, outcome.childIssues, {
    integration: outcome.kind === 'integration',
  }))) return false;
  const prs = outcome.evidence.filter(source => source.sourceType === 'pull_request');
  if (outcome.childIssues.some(childIssue => !prs.some(pr => pr.childIssue === childIssue))) return false;
  if (prs.some(pr => !outcome.evidence.some(check => ['workflow_run', 'check_run'].includes(check.sourceType)
    && check.status === 'success' && check.childIssue === pr.childIssue
    && check.revision.toLowerCase() === pr.reviewedRevision.toLowerCase()))) return false;
  if (outcome.kind === 'integration' && !outcome.evidence.some(source =>
    source.sourceType === 'workflow_run' && source.status === 'success' && source.childIssue === undefined)) return false;
  return true;
}

function validSerializedScopeEvolution(criterion) {
  const evolution = criterion?.scopeEvolution;
  if (evolution === undefined) return true;
  return isObject(evolution)
    && typeof evolution.previousText === 'string' && evolution.previousText.trim() !== ''
    && evolution.previousText !== criterion.text
    && validJarvisUrl(evolution.authorizationUrl)
    && typeof evolution.rationale === 'string' && evolution.rationale.trim() !== '';
}

export function renderFinalAssessmentComment(report) {
  if (!isObject(report) || !isIssueNumber(report.parentIssue) || !Number.isSafeInteger(report.childCount)
    || report.childCount < 1 || !Array.isArray(report.criteria) || report.criteria.length === 0
    || report.criteria.some(criterion => criterion.status !== 'validated')) {
    throw new Error('Cannot render a final assessment unless every criterion is validated.');
  }
  const payload = {
    schemaVersion: 1,
    parentIssue: report.parentIssue,
    childCount: report.childCount,
    criteria: report.criteria.map(criterion => ({
      index: criterion.index,
      text: criterion.text,
      status: criterion.status,
      reason: criterion.reason ?? null,
      ...(criterion.scopeEvolution ? { scopeEvolution: criterion.scopeEvolution } : {}),
      outcomes: criterion.outcomes,
    })),
  };
  const nativeChildren = new Set(payload.criteria.flatMap(criterion =>
    Array.isArray(criterion.outcomes) ? criterion.outcomes.flatMap(outcome => outcome.childIssues ?? []) : []));
  const childByPullRequest = new Map();
  const validCriteria = payload.criteria.every((criterion, index) => Number.isSafeInteger(criterion.index)
    && criterion.index === index + 1 && typeof criterion.text === 'string' && criterion.text.trim()
    && validSerializedScopeEvolution(criterion)
    && Array.isArray(criterion.outcomes) && criterion.outcomes.length > 0
    && criterion.outcomes.every(outcome => validSerializedOutcome(outcome, nativeChildren)));
  for (const criterion of payload.criteria) {
    for (const outcome of criterion.outcomes ?? []) {
      for (const source of outcome.evidence ?? []) {
        if (source.sourceType !== 'pull_request') continue;
        const number = pullRequestNumber(source.url);
        const priorChild = childByPullRequest.get(number);
        if (priorChild !== undefined && priorChild !== source.childIssue) {
          throw new Error('Cannot render a final assessment with conflicting PR-to-child mappings.');
        }
        childByPullRequest.set(number, source.childIssue);
      }
    }
  }
  if (!validCriteria || nativeChildren.size !== report.childCount) {
    throw new Error('Cannot render a final assessment without validated child and integration evidence.');
  }
  const visible = [
    finalAssessmentMarker(report.parentIssue),
    `<!-- jarvis:coordination-parent-data:v1:${encodePayload(payload)} -->`,
    `## Parent acceptance assessment — #${report.parentIssue}`,
    'Every acceptance criterion is validated.',
  ];
  for (const criterion of report.criteria) {
    visible.push('', `- **Criterion ${criterion.index}: validated** — ${markdownText(criterion.text)}`);
    if (criterion.scopeEvolution) {
      visible.push(`  - **Authorized wording evolution:** previous wording: ${markdownText(criterion.scopeEvolution.previousText)}; rationale: ${markdownText(criterion.scopeEvolution.rationale)}; source: <${criterion.scopeEvolution.authorizationUrl}>.`);
    }
    for (const outcome of criterion.outcomes) {
      visible.push(`  - ${markdownText(outcome.description)} (${outcome.kind}; children ${outcome.childIssues.map(number => `#${number}`).join(', ')}).`);
      for (const source of outcome.evidence) {
        const revision = source.sourceType === 'pull_request'
          ? `merge ${source.revision}; reviewed head ${source.reviewedRevision}`
          : source.revision ? `revision ${source.revision}` : null;
        const details = [source.sourceType, source.status, ...(revision ? [revision] : [])].join('; ');
        visible.push(`    - **${markdownText(source.label)}** (${details}) — <${source.url}>`);
      }
    }
  }
  return visible.join('\n');
}

export function parseFinalAssessmentComment(comment, { parentIssue, criteria, childIssues }) {
  const payload = decodePayload(comment, finalAssessmentMarker(parentIssue));
  if (!isObject(payload) || payload.schemaVersion !== 1 || payload.parentIssue !== parentIssue
    || payload.childCount !== childIssues.length || !Array.isArray(payload.criteria)
    || payload.criteria.length !== criteria.length) return null;
  const nativeChildren = new Set(childIssues);
  const coveredChildren = new Set();
  const childByPullRequest = new Map();
  for (let index = 0; index < criteria.length; index += 1) {
    const item = criteria[index];
    const assessed = payload.criteria[index];
    if (!isObject(assessed) || assessed.index !== item.index || assessed.text !== item.text
      || assessed.status !== 'validated' || !Array.isArray(assessed.outcomes) || assessed.outcomes.length === 0
      || assessed.outcomes.some(outcome => !validSerializedOutcome(outcome, nativeChildren))) return null;
    for (const outcome of assessed.outcomes) {
      for (const childIssue of outcome.childIssues) coveredChildren.add(childIssue);
      for (const source of outcome.evidence) {
        if (source.sourceType !== 'pull_request') continue;
        const number = pullRequestNumber(source.url);
        const priorChild = childByPullRequest.get(number);
        if (priorChild !== undefined && priorChild !== source.childIssue) return null;
        childByPullRequest.set(number, source.childIssue);
      }
    }
  }
  if (coveredChildren.size !== nativeChildren.size || [...nativeChildren].some(child => !coveredChildren.has(child))) return null;
  if (comment.body !== renderFinalAssessmentComment(payload)) return null;
  return payload;
}

export function indexCoordinationParentComments(comments, { parentIssue, criteria, childIssues }) {
  if (!Array.isArray(comments)) return { valid: false, reason: 'invalid_comment_inventory' };
  const deliveries = new Map();
  const markerByChild = new Map();
  const finals = [];
  for (const comment of comments) {
    const lines = commentLines(comment);
    if (lines.some(line => line.startsWith(LEGACY_DELIVERY_MARKER(parentIssue)))) {
      return { valid: false, reason: 'child_delivery_comment_invalid', deliveries };
    }
    const deliveryLines = lines.filter(line => line.startsWith(DELIVERY_MARKER(parentIssue)));
    if (deliveryLines.length > 0) {
      if (deliveryLines.length !== 1) return { valid: false, reason: 'child_delivery_comment_invalid', deliveries };
      const deliveryLine = deliveryLines[0];
      const match = deliveryLine.match(/^<!-- jarvis:coordination-parent-delivery:v2:(\d+):(\d+):([0-9a-f]{64}) -->$/);
      if (!match) return { valid: false, reason: 'child_delivery_comment_invalid' };
      const childIssue = Number(match[2]);
      if (!childIssues.includes(childIssue)) return { valid: false, reason: 'child_delivery_comment_invalid' };
      const parsed = parseChildDeliveryComment(comment, parentIssue, childIssue);
      if (!parsed) return { valid: false, reason: 'child_delivery_comment_invalid', deliveries };
      const markers = markerByChild.get(childIssue) ?? new Set();
      if (markers.has(deliveryLine)) return { valid: false, reason: 'child_delivery_comment_invalid', deliveries };
      markers.add(deliveryLine);
      markerByChild.set(childIssue, markers);
      const existing = deliveries.get(childIssue) ?? [];
      existing.push({ ...parsed, marker: deliveryLine });
      deliveries.set(childIssue, existing);
      continue;
    }
    if (lines.includes(finalAssessmentMarker(parentIssue))) finals.push(comment);
  }
  for (const childIssue of childIssues) {
    const records = deliveries.get(childIssue) ?? [];
    if (records.length === 0) return { valid: false, reason: 'child_delivery_comment_missing', deliveries };
  }
  const childByPullRequest = new Map();
  for (const [childIssue, records] of deliveries) {
    for (const record of records) {
      for (const source of record.evidence) {
        if (source.sourceType !== 'pull_request') continue;
        const number = pullRequestNumber(source.url);
        const priorChild = childByPullRequest.get(number);
        if (priorChild !== undefined && priorChild !== childIssue) {
          return { valid: false, reason: 'pull_request_child_mapping_conflict', deliveries };
        }
        childByPullRequest.set(number, childIssue);
      }
    }
  }
  if (finals.length === 0) return { valid: false, reason: 'final_assessment_missing', deliveries };
  if (finals.length !== 1) return { valid: false, reason: 'final_assessment_invalid', deliveries };
  const assessment = parseFinalAssessmentComment(finals[0], { parentIssue, criteria, childIssues });
  if (!assessment) return { valid: false, reason: 'final_assessment_invalid', deliveries };
  const evidenceKey = source => [source.sourceType, source.url, source.status, source.revision ?? '', source.reviewedRevision ?? '', source.childIssue ?? ''].join('|');
  for (const criterion of assessment.criteria) {
    for (const outcome of criterion.outcomes) {
      for (const source of outcome.evidence) {
        if (source.childIssue === undefined
          || !['pull_request', 'workflow_run', 'check_run'].includes(source.sourceType)) continue;
        const deliveryRecords = deliveries.get(source.childIssue) ?? [];
        const matchingDelivery = deliveryRecords.some(delivery => delivery.evidenceStatus === 'validated'
          && delivery.evidence.some(item => evidenceKey(item) === evidenceKey(source)));
        if (!matchingDelivery) {
          return { valid: false, reason: 'final_assessment_invalid', deliveries };
        }
      }
    }
  }
  return { valid: true, deliveries, finalComment: finals[0], assessment };
}
