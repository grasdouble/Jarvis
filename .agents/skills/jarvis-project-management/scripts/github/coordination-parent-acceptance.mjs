#!/usr/bin/env node
/** Record a caller's evidence-backed coordination-parent acceptance assessment. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { appNetworkError, NETWORK_EXIT_CODE } from './gh-app.mjs';
import {
  childDeliveryMarker,
  finalAssessmentMarker,
  indexCoordinationParentComments,
  parseChildDeliveryComment,
  parseFinalAssessmentComment,
  renderChildDeliveryComment,
  renderFinalAssessmentComment,
} from './coordination-parent-comments.mjs';

const REPOSITORY_PATH = 'repos/grasdouble/Jarvis';
const API_HELPER = fileURLToPath(new URL('./gh-app.mjs', import.meta.url));
const STATUSES = new Set(['validated', 'not_yet_validated', 'unable_to_assess']);
const OUTCOME_KINDS = new Set(['child', 'integration']);
const EVIDENCE_SOURCE_STATUSES = {
  pull_request: new Set(['merged', 'open', 'closed']),
  workflow_run: new Set(['success', 'failure', 'skipped', 'in_progress']),
  check_run: new Set(['success', 'failure', 'skipped', 'in_progress']),
  commit: new Set(['present', 'missing']),
  release: new Set(['published', 'draft', 'missing']),
  issue_comment: new Set(['available', 'missing']),
  other: new Set(['verified', 'unverified']),
};
const SUCCESSFUL_EVIDENCE_STATUS = {
  pull_request: 'merged',
  workflow_run: 'success',
  check_run: 'success',
  commit: 'present',
  release: 'published',
  issue_comment: 'available',
  other: 'verified',
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIssueNumber = value => Number.isSafeInteger(value) && value > 0;
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function visibleMarkdownLines(body) {
  const lines = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) fence = null;
      lines.push(null);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      lines.push(null);
      continue;
    }
    lines.push(line);
  }
  return { lines, malformed: fence !== null };
}

function heading(line) {
  const match = line?.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*$/);
  if (!match) return null;
  return {
    level: match[1].length,
    title: match[2].replace(/[ \t]+#+[ \t]*$/, '').trim(),
  };
}

function invalidChecklist(reason, items = []) {
  return {
    valid: false,
    total: items.length,
    unchecked: items.filter(item => !item.checked).length,
    items,
    reason,
  };
}

/** Parse one unambiguous Markdown Acceptance criteria task list. */
export function parseAcceptanceChecklist(body) {
  if (typeof body !== 'string') return invalidChecklist('criteria_malformed');
  const { lines, malformed: malformedFence } = visibleMarkdownLines(body);
  if (malformedFence) return invalidChecklist('criteria_malformed');

  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const item = heading(lines[index]);
    if (item?.title.toLowerCase() === 'acceptance criteria') sections.push({ index, level: item.level });
  }
  if (sections.length === 0) return invalidChecklist('criteria_missing');
  if (sections.length !== 1) return invalidChecklist('criteria_ambiguous');

  const [{ index: start, level }] = sections;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const item = heading(lines[index]);
    if (item && item.level <= level) {
      end = index;
      break;
    }
  }
  if (lines.slice(start + 1, end).some(line => line !== null && (line.includes('<!--') || line.includes('-->')))) {
    return invalidChecklist('criteria_malformed');
  }

  const items = [];
  let malformed = false;
  const task = /^([ \t]*)(?:[-*+]|\d+[.)])([ \t]+)\[([^\]]*)\](?:([ \t]+)(.*?))?([ \t]*)$/;
  for (let lineIndex = start + 1; lineIndex < end; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === null) continue;
    if (line.includes('<') || line.includes('>') || /^\s*>.*\[[ xX]?\]/.test(line)) {
      malformed = true;
      continue;
    }
    const match = line.match(task);
    if (!match) continue;
    const marker = match[3];
    const text = match[5] ?? '';
    if (match[1].includes('\t') || match[1].length >= 4
      || (marker !== ' ' && marker.toLowerCase() !== 'x') || text.trim() === '') {
      malformed = true;
      continue;
    }
    const markerIndex = line.indexOf('[') + 1;
    const textEnd = line.length - (match[6] ?? '').length;
    items.push({
      index: items.length + 1,
      text,
      checked: marker.toLowerCase() === 'x',
      lineIndex,
      markerIndex,
      textStart: textEnd - text.length,
      textEnd,
    });
  }

  if (malformed) return invalidChecklist('criteria_malformed', items);
  if (items.length === 0) return invalidChecklist('criteria_empty');
  return {
    valid: true,
    total: items.length,
    unchecked: items.filter(item => !item.checked).length,
    sectionLevel: level,
    items,
  };
}

/** Parse structurally valid criteria without treating checkbox state as acceptance evidence. */
export function parseAcceptanceCriteria(body) {
  const parsed = parseAcceptanceChecklist(body);
  const { lines, malformed: malformedFence } = typeof body === 'string'
    ? visibleMarkdownLines(body)
    : { lines: [], malformed: true };
  if (malformedFence) {
    return { valid: false, total: parsed.total, unchecked: parsed.unchecked, reason: 'criteria_malformed' };
  }

  const bodyComment = lines.some(line => line !== null && (line.includes('<!--') || line.includes('-->')));
  if (bodyComment) {
    return { valid: false, total: parsed.total, unchecked: parsed.unchecked, reason: 'criteria_malformed' };
  }

  if (!parsed.valid) {
    return {
      valid: false,
      total: parsed.total,
      unchecked: parsed.unchecked,
      reason: parsed.reason,
    };
  }
  return { valid: true, total: parsed.total, unchecked: parsed.unchecked };
}

function repositoryIsJarvis(issue) {
  if (typeof issue?.repository_url !== 'string') return false;
  try {
    const url = new URL(issue.repository_url);
    return url.origin === 'https://api.github.com'
      && url.pathname.toLowerCase() === '/repos/grasdouble/jarvis';
  } catch {
    return false;
  }
}

function validIssueRecord(issue) {
  return isObject(issue)
    && !Object.hasOwn(issue, 'pull_request')
    && isIssueNumber(issue.number)
    && ['open', 'closed'].includes(String(issue.state).toLowerCase())
    && repositoryIsJarvis(issue);
}

function childInventory(parent, childPages) {
  const summary = parent.sub_issues_summary ?? parent.subIssuesSummary;
  const expected = isObject(summary) && Number.isSafeInteger(summary.total) && summary.total >= 0
    ? summary.total
    : null;
  if (!Array.isArray(childPages) || childPages.length === 0 || childPages.some(page => !Array.isArray(page))
    || expected === null) return { valid: false, reason: 'incomplete_child_inventory' };
  if (expected === 0) return { valid: false, reason: 'no_native_children' };

  const children = childPages.flat();
  const numbers = children.map(child => child?.number);
  if (children.length !== expected || numbers.some(number => !isIssueNumber(number))
    || new Set(numbers).size !== numbers.length || children.some(child => !validIssueRecord(child))) {
    return { valid: false, reason: 'incomplete_child_inventory' };
  }
  return { valid: true, children: new Map(children.map(child => [child.number, child])) };
}

function validEvidenceUrl(value) {
  if (!nonEmpty(value) || /\s/.test(value) || value.includes('<') || value.includes('>')
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.search === ''
      && !url.username
      && !url.password
      && url.pathname.toLowerCase().startsWith('/grasdouble/jarvis/');
  } catch {
    return false;
  }
}

function validateEvidence(value, kind, childIssues) {
  if (!Array.isArray(value)) return { valid: false, evidence: [] };
  const evidence = [];
  for (const item of value) {
    if (!isObject(item) || !validEvidenceUrl(item.url) || !nonEmpty(item.label)
      || !Object.hasOwn(EVIDENCE_SOURCE_STATUSES, item.sourceType)
      || !EVIDENCE_SOURCE_STATUSES[item.sourceType].has(item.status)) {
      return { valid: false, evidence: [] };
    }
    let url;
    try {
      url = new URL(item.url);
    } catch {
      return { valid: false, evidence: [] };
    }
    const pathname = url.pathname.toLowerCase();
    const validPath = {
      pull_request: /^\/grasdouble\/jarvis\/pull\/\d+(?:\/.*)?$/,
      workflow_run: /^\/grasdouble\/jarvis\/actions\/runs\/\d+$/,
      check_run: /^\/grasdouble\/jarvis\/commit\/[0-9a-f]{40}(?:\/checks)?$/,
      commit: /^\/grasdouble\/jarvis\/commit\/[0-9a-f]{40}$/,
      release: /^\/grasdouble\/jarvis\/releases\/tag\/.+$/,
      issue_comment: /^\/grasdouble\/jarvis\/(?:issues|pull)\/\d+$/,
      other: /^\/grasdouble\/jarvis\/.+$/,
    }[item.sourceType];
    if (!validPath.test(pathname)) return { valid: false, evidence: [] };
    if (['pull_request', 'workflow_run', 'check_run', 'commit'].includes(item.sourceType)
      && (typeof item.revision !== 'string' || !/^[0-9a-f]{40}$/i.test(item.revision))) {
      return { valid: false, evidence: [] };
    }
    if (item.sourceType === 'pull_request'
      && (typeof item.reviewedRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(item.reviewedRevision))) {
      return { valid: false, evidence: [] };
    }
    if (['commit', 'check_run'].includes(item.sourceType)
      && pathname.slice('/grasdouble/jarvis/commit/'.length).replace(/\/checks$/, '') !== item.revision.toLowerCase()) {
      return { valid: false, evidence: [] };
    }
    if (item.sourceType === 'issue_comment' && !/^#(?:issuecomment-\d+|discussion_r\d+)$/i.test(url.hash)) {
      return { valid: false, evidence: [] };
    }
    if (item.sourceType !== 'issue_comment' && url.hash !== '') {
      return { valid: false, evidence: [] };
    }
    if (item.childIssue !== undefined
      && (!isIssueNumber(item.childIssue) || !childIssues.includes(item.childIssue))) {
      return { valid: false, evidence: [] };
    }
    if ((kind === 'child' || kind === 'integration') && item.sourceType === 'pull_request'
      && item.childIssue === undefined) {
      return { valid: false, evidence: [] };
    }
    evidence.push({
      url: item.url,
      label: item.label.trim(),
      sourceType: item.sourceType,
      status: item.status,
      ...(item.revision ? { revision: item.revision } : {}),
      ...(item.reviewedRevision ? { reviewedRevision: item.reviewedRevision } : {}),
      ...(item.childIssue !== undefined ? { childIssue: item.childIssue } : {}),
    });
  }
  return { valid: true, evidence };
}

function validScopeEvolution(evolution, currentText, replacementText) {
  if (!isObject(evolution)
    || !nonEmpty(evolution.previousText)
    || evolution.previousText.trim() === replacementText
    || !validEvidenceUrl(evolution.authorizationUrl)
    || !nonEmpty(evolution.rationale)) return null;
  const previousText = evolution.previousText;
  if (currentText !== previousText && currentText !== replacementText) return null;
  return {
    previousText,
    authorizationUrl: evolution.authorizationUrl,
    rationale: evolution.rationale.trim(),
    replaceText: currentText === previousText,
  };
}

function validateOutcome(outcome, childMap) {
  const result = {
    status: 'unable_to_assess',
    reason: 'outcome_malformed',
    description: '',
    kind: null,
    childIssues: [],
    evidence: [],
    rationale: '',
  };
  if (!isObject(outcome) || !nonEmpty(outcome.description)
    || !STATUSES.has(outcome.status) || !OUTCOME_KINDS.has(outcome.kind)
    || !Array.isArray(outcome.childIssues)) return result;
  if (!outcome.childIssues.every(isIssueNumber)
    || new Set(outcome.childIssues).size !== outcome.childIssues.length) return result;
  if (!outcome.childIssues.every(number => childMap.has(number))) {
    return { ...result, reason: 'child_not_native' };
  }
  const parsedEvidence = validateEvidence(outcome.evidence, outcome.kind, outcome.childIssues);
  if (!parsedEvidence.valid) return { ...result, reason: 'evidence_malformed' };
  if (outcome.status !== 'validated' && !nonEmpty(outcome.rationale)) {
    return { ...result, reason: 'rationale_missing' };
  }

  const childIssues = [...outcome.childIssues];
  const evidence = parsedEvidence.evidence;
  let status = outcome.status;
  let reason = null;
  const unsuccessfulEvidence = evidence.find(source => source.status !== SUCCESSFUL_EVIDENCE_STATUS[source.sourceType]);
  if (outcome.kind === 'child' && childIssues.length !== 1) {
    return { ...result, reason: 'child_outcome_mapping_invalid' };
  }
  if (status === 'validated' && evidence.length === 0) {
    status = 'not_yet_validated';
    reason = 'delivery_evidence_missing';
  } else if (status === 'validated' && unsuccessfulEvidence) {
    status = 'not_yet_validated';
    reason = unsuccessfulEvidence.sourceType === 'pull_request'
      ? 'delivery_pr_not_merged'
      : ['workflow_run', 'check_run'].includes(unsuccessfulEvidence.sourceType)
        ? 'required_check_not_successful'
        : 'evidence_not_available';
  } else if (status === 'validated' && childIssues.some(number => {
    const child = childMap.get(number);
    return String(child.state).toLowerCase() !== 'closed'
      || String(child.state_reason ?? child.stateReason ?? '').toLowerCase() !== 'completed';
  })) {
    status = 'not_yet_validated';
    reason = 'child_delivery_incomplete';
  } else if (status === 'validated' && (outcome.kind === 'child' || outcome.kind === 'integration')) {
    if (outcome.kind === 'integration' && childIssues.length < 2) {
      status = 'not_yet_validated';
      reason = 'integration_evidence_incomplete';
    } else {
      const pullRequests = evidence.filter(source => source.sourceType === 'pull_request');
      const missingChildDelivery = childIssues.some(number => !pullRequests.some(source => source.childIssue === number));
      if (missingChildDelivery) {
        status = 'not_yet_validated';
        reason = 'child_delivery_pr_missing';
      } else {
        const missingCurrentHeadCheck = pullRequests.some(pr => !evidence.some(source =>
          ['workflow_run', 'check_run'].includes(source.sourceType)
          && source.status === 'success'
          && source.childIssue === pr.childIssue
          && source.revision === pr.reviewedRevision));
        if (missingCurrentHeadCheck) {
          status = 'not_yet_validated';
          reason = 'current_head_check_missing';
        } else if (outcome.kind === 'integration' && !evidence.some(source =>
          source.sourceType === 'workflow_run'
          && source.status === 'success'
          && source.childIssue === undefined)) {
          status = 'not_yet_validated';
          reason = 'integration_evidence_incomplete';
        }
      }
    }
  }

  return {
    status,
    reason,
    description: outcome.description.trim(),
    kind: outcome.kind,
    childIssues,
    evidence,
    rationale: nonEmpty(outcome.rationale) ? outcome.rationale.trim() : '',
  };
}

function pullRequestNumber(urlValue) {
  try {
    const match = new URL(urlValue).pathname.toLowerCase().match(/^\/grasdouble\/jarvis\/pull\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pullRequestMappingConflicts(criteria) {
  const childByPullRequest = new Map();
  const conflicts = new Set();
  for (const criterion of criteria) {
    for (const outcome of criterion.outcomes) {
      for (const source of outcome.evidence) {
        if (source.sourceType !== 'pull_request' || source.childIssue === undefined) continue;
        const number = pullRequestNumber(source.url);
        if (number === null) continue;
        const existingChild = childByPullRequest.get(number);
        if (existingChild !== undefined && existingChild !== source.childIssue) conflicts.add(number);
        else childByPullRequest.set(number, source.childIssue);
      }
    }
  }
  return conflicts;
}

function markConflictingPullRequestCriteria(criteria, conflicts) {
  return criteria.map(criterion => {
    let affected = false;
    const outcomes = criterion.outcomes.map(outcome => {
      const conflict = outcome.evidence.some(source => source.sourceType === 'pull_request'
        && conflicts.has(pullRequestNumber(source.url)));
      if (!conflict) return outcome;
      affected = true;
      return { ...outcome, status: 'unable_to_assess', reason: 'pull_request_child_mapping_conflict' };
    });
    return affected
      ? { ...criterion, status: 'unable_to_assess', reason: 'pull_request_child_mapping_conflict', outcomes }
      : criterion;
  });
}

function assessedCriterion(item, entry, childMap) {
  if (!entry) {
    return {
      index: item.index,
      text: item.text,
      status: 'unable_to_assess',
      reason: 'assessment_missing',
      outcomes: [],
      scopeEvolution: null,
    };
  }
  if (!isObject(entry) || entry.index !== item.index || !nonEmpty(entry.text)
    || entry.text !== entry.text.trim() || entry.text.includes('\n') || entry.text.includes('\r')
    || entry.text.includes('<') || entry.text.includes('>')
    || entry.text.includes('<!--') || entry.text.includes('-->')) {
    return {
      index: item.index,
      text: item.text,
      status: 'unable_to_assess',
      reason: 'assessment_malformed',
      outcomes: [],
      scopeEvolution: null,
    };
  }

  let scopeEvolution = null;
  if (entry.text !== item.text) {
    scopeEvolution = validScopeEvolution(entry.scopeEvolution, item.text, entry.text);
    if (!scopeEvolution) {
      return {
        index: item.index,
        text: item.text,
        status: 'unable_to_assess',
        reason: 'criterion_text_mismatch',
        outcomes: [],
        scopeEvolution: null,
      };
    }
  } else if (entry.scopeEvolution !== undefined) {
    scopeEvolution = validScopeEvolution(entry.scopeEvolution, item.text, entry.text);
    if (!scopeEvolution) {
      return {
        index: item.index,
        text: item.text,
        status: 'unable_to_assess',
        reason: 'scope_evolution_invalid',
        outcomes: [],
        scopeEvolution: null,
      };
    }
  }

  if (!Array.isArray(entry.outcomes) || entry.outcomes.length === 0) {
    return {
      index: item.index,
      text: entry.text,
      status: 'unable_to_assess',
      reason: 'outcomes_missing',
      outcomes: [],
      scopeEvolution,
    };
  }
  const outcomes = entry.outcomes.map(outcome => validateOutcome(outcome, childMap));
  let status = 'validated';
  if (outcomes.some(outcome => outcome.status === 'unable_to_assess')) status = 'unable_to_assess';
  else if (outcomes.some(outcome => outcome.status === 'not_yet_validated')) status = 'not_yet_validated';
  const reason = outcomes.find(outcome => outcome.reason)?.reason ?? null;
  if (status === 'validated' && scopeEvolution?.replaceText) {
    status = 'not_yet_validated';
    return {
      index: item.index,
      text: entry.text,
      status,
      reason: 'criterion_scope_alignment_required',
      outcomes,
      scopeEvolution,
    };
  }
  return {
    index: item.index,
    text: entry.text,
    status,
    reason,
    outcomes,
    scopeEvolution,
  };
}

/**
 * Validate a reviewed assessment against the live parent checklist and complete native child inventory.
 * Semantic evidence adequacy remains the caller's responsibility; this function checks structure and child state.
 */
export function assessParentAcceptance({ parent, childPages, assessment }) {
  if (!validIssueRecord(parent) || typeof parent.body !== 'string'
    || !isIssueNumber(assessment?.parentIssue) || assessment.parentIssue !== parent.number
    || !Array.isArray(assessment.criteria) || assessment.criteria.length === 0) {
    return { decision: 'unable_to_assess', parentIssue: parent?.number, canRecord: false, reason: 'invalid_assessment_data', criteria: [] };
  }
  const checklist = parseAcceptanceChecklist(parent.body);
  if (!checklist.valid) {
    return { decision: 'unable_to_assess', parentIssue: parent.number, canRecord: false, reason: checklist.reason, criteria: [] };
  }
  const structuralCriteria = parseAcceptanceCriteria(parent.body);
  if (!structuralCriteria.valid) {
    return {
      decision: 'unable_to_assess', parentIssue: parent.number, canRecord: false,
      reason: structuralCriteria.reason, criteria: [],
    };
  }
  const inventory = childInventory(parent, childPages);
  if (!inventory.valid) {
    return { decision: 'unable_to_assess', parentIssue: parent.number, canRecord: false, reason: inventory.reason, criteria: [] };
  }

  const entries = new Map();
  for (const entry of assessment.criteria) {
    if (!isObject(entry) || !Number.isSafeInteger(entry.index) || entry.index < 1
      || entry.index > checklist.items.length || entries.has(entry.index)) {
      return { decision: 'unable_to_assess', parentIssue: parent.number, canRecord: false, reason: 'assessment_criteria_invalid', criteria: [] };
    }
    entries.set(entry.index, entry);
  }
  let criteria = checklist.items.map(item => assessedCriterion(item, entries.get(item.index), inventory.children));
  const conflictingPullRequestNumbers = pullRequestMappingConflicts(criteria);
  if (conflictingPullRequestNumbers.size > 0) {
    criteria = markConflictingPullRequestCriteria(criteria, conflictingPullRequestNumbers);
    return {
      decision: 'unable_to_assess',
      parentIssue: parent.number,
      childCount: inventory.children.size,
      sectionLevel: checklist.sectionLevel,
      canRecord: false,
      reason: 'pull_request_child_mapping_conflict',
      conflictingPullRequestNumbers: [...conflictingPullRequestNumbers].sort((left, right) => left - right),
      criteria,
    };
  }
  const assessedChildIssues = new Set(criteria.flatMap(criterion => criterion.outcomes.flatMap(outcome => outcome.childIssues)));
  const unassessedChildIssues = [...inventory.children.keys()].filter(number => !assessedChildIssues.has(number));
  if (unassessedChildIssues.length > 0) {
    return {
      decision: 'unable_to_assess',
      parentIssue: parent.number,
      childCount: inventory.children.size,
      sectionLevel: checklist.sectionLevel,
      canRecord: false,
      reason: 'child_outcome_coverage_incomplete',
      unassessedChildIssues,
      criteria,
    };
  }
  return {
    decision: 'assessed',
    parentIssue: parent.number,
    childCount: inventory.children.size,
    sectionLevel: checklist.sectionLevel,
    canRecord: true,
    criteria,
  };
}

function helperEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_') || [
      'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
      'GH_DEBUG', 'GH_HOST', 'GH_REPO', 'GH_CONFIG_DIR', 'NODE_OPTIONS',
      'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_ASKPASS', 'SSH_ASKPASS',
    ].includes(name)) delete env[name];
  }
  return env;
}

function runReviewedHelper(args, { write = false } = {}) {
  const prefix = write ? ['--write', '--'] : ['--'];
  try {
    return execFileSync(process.execPath, [API_HELPER, ...prefix, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: helperEnvironment(),
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const network = appNetworkError(error);
    if (network) throw network;
    throw new Error('GitHub operation failed; reread current issue state before retrying.');
  }
}

function apiJson(runGh, args, options) {
  const output = runGh(['api', ...args], options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub returned invalid or unavailable issue data.');
  }
}

export function createAcceptanceGitHubClient(runGh = runReviewedHelper, { writeEnabled = false } = {}) {
  const client = {
    getIssue(number) {
      return apiJson(runGh, [`${REPOSITORY_PATH}/issues/${number}`]);
    },
    listSubIssuePages(number) {
      return apiJson(runGh, [
        '--method', 'GET', '--paginate', '--slurp',
        `${REPOSITORY_PATH}/issues/${number}/sub_issues?per_page=100`,
      ]);
    },
    listIssueComments(number) {
      const pages = apiJson(runGh, [
        '--method', 'GET', '--paginate', '--slurp',
        `${REPOSITORY_PATH}/issues/${number}/comments?per_page=100`,
      ]);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
        throw new Error('GitHub returned an incomplete issue-comment inventory.');
      }
      return pages.flat();
    },
  };
  if (writeEnabled) {
    client.createIssueComment = (number, body) => {
      runGh([
        'api', '--method', 'POST', `${REPOSITORY_PATH}/issues/${number}/comments`,
        '--raw-field', `body=${body}`,
      ], { write: true });
    };
  }
  return client;
}

function issueCommentsWithMarker(comments, marker) {
  return comments.filter(comment => typeof comment?.body === 'string'
    && comment.body.split(/\r?\n/).includes(marker));
}

function uniqueEvidence(sources) {
  const items = new Map();
  for (const source of sources) {
    const key = [source.sourceType, source.url, source.status, source.revision ?? '', source.reviewedRevision ?? '', source.childIssue ?? ''].join('|');
    if (!items.has(key)) items.set(key, source);
  }
  return [...items.values()].sort((left, right) =>
    left.sourceType.localeCompare(right.sourceType) || left.url.localeCompare(right.url));
}

function deliveryPayloadForChild(report, child) {
  if (String(child.state).toLowerCase() !== 'closed'
    || String(child.state_reason ?? child.stateReason ?? '').toLowerCase() !== 'completed') return null;
  const sources = report.criteria.flatMap(criterion => criterion.outcomes.flatMap(outcome => outcome.evidence))
    .filter(source => source.childIssue === child.number);
  const pullRequests = uniqueEvidence(sources.filter(source =>
    source.sourceType === 'pull_request' && source.status === 'merged'));
  if (pullRequests.length === 0) return null;
  const checks = uniqueEvidence(sources.filter(source => ['workflow_run', 'check_run'].includes(source.sourceType)
    && source.status === 'success'));
  const currentChecks = [];
  for (const pr of pullRequests) {
    const matching = checks.filter(check => check.revision.toLowerCase() === pr.reviewedRevision.toLowerCase());
    if (matching.length === 0) return null;
    currentChecks.push(...matching);
  }
  const evidence = uniqueEvidence([...pullRequests, ...currentChecks]);
  return {
    schemaVersion: 1,
    parentIssue: report.parentIssue,
    childIssue: child.number,
    state: 'closed',
    stateReason: 'completed',
    evidence,
  };
}

function criterionSummary(criteria) {
  return criteria.map(criterion => ({
    index: criterion.index,
    text: criterion.text,
    status: criterion.status,
    ...(criterion.reason ? { reason: criterion.reason } : {}),
    ...(criterion.scopeEvolution ? {
      scopeEvolution: {
        previousText: criterion.scopeEvolution.previousText,
        authorizationUrl: criterion.scopeEvolution.authorizationUrl,
        rationale: criterion.scopeEvolution.rationale,
      },
    } : {}),
    outcomes: criterion.outcomes.map(outcome => ({
      description: outcome.description,
      kind: outcome.kind,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      childIssues: outcome.childIssues,
      evidence: outcome.evidence,
      ...(outcome.rationale ? { rationale: outcome.rationale } : {}),
    })),
  }));
}

function inspectCommentPlan(report, parent, childPages, comments) {
  const children = childPages.flat();
  const childDelivery = { pending: [], existing: [], missingEvidence: [], recorded: [] };
  const payloads = new Map();
  const prefix = `<!-- jarvis:coordination-parent-delivery:v1:${parent.number}:`;
  const expectedChildren = new Set(children.map(child => child.number));
  for (const comment of comments) {
    for (const line of typeof comment?.body === 'string' ? comment.body.split(/\r?\n/) : []) {
      if (!line.startsWith(prefix)) continue;
      const match = line.match(/^<!-- jarvis:coordination-parent-delivery:v1:(\d+):(\d+) -->$/);
      if (!match || !expectedChildren.has(Number(match[2]))) {
        return { valid: false, reason: 'child_delivery_comment_invalid', childDelivery, children };
      }
    }
  }

  for (const child of children) {
    const payload = deliveryPayloadForChild(report, child);
    const marker = childDeliveryMarker(parent.number, child.number);
    const existing = issueCommentsWithMarker(comments, marker);
    if (existing.length > 1) return { valid: false, reason: 'child_delivery_comment_invalid', childDelivery, children };
    if (existing.length === 1) {
      const parsed = parseChildDeliveryComment(existing[0], parent.number, child.number);
      if (!parsed) {
        return { valid: false, reason: 'child_delivery_comment_conflict', childDelivery, children };
      }
      payloads.set(child.number, { payload: parsed, body: existing[0].body });
      childDelivery.existing.push(child.number);
      continue;
    }
    if (payload) {
      try {
        const expectedBody = renderChildDeliveryComment(payload);
        payloads.set(child.number, { payload, body: expectedBody });
        childDelivery.pending.push(child.number);
      } catch {
        childDelivery.missingEvidence.push(child.number);
      }
    } else if (String(child.state).toLowerCase() === 'closed'
      && String(child.state_reason ?? child.stateReason ?? '').toLowerCase() === 'completed') {
      childDelivery.missingEvidence.push(child.number);
    }
  }

  const deliveryEvidenceKey = source => [source.sourceType, source.url, source.status,
    source.revision ?? '', source.reviewedRevision ?? '', source.childIssue ?? ''].join('|');
  for (const criterion of report.criteria) {
    for (const outcome of criterion.outcomes) {
      for (const source of outcome.evidence) {
        if (!source.childIssue || !['pull_request', 'workflow_run', 'check_run'].includes(source.sourceType)) continue;
        const delivery = payloads.get(source.childIssue)?.payload;
        if (!delivery?.evidence.some(item => deliveryEvidenceKey(item) === deliveryEvidenceKey(source))) {
          return { valid: false, reason: 'child_delivery_comment_evidence_mismatch', childDelivery, children };
        }
      }
    }
  }

  const incompleteChildren = children.filter(child => String(child.state).toLowerCase() !== 'closed'
    || String(child.state_reason ?? child.stateReason ?? '').toLowerCase() !== 'completed')
    .map(child => child.number);
  const missingDelivery = children.filter(child => !payloads.has(child.number)).map(child => child.number);
  const allCriteriaValidated = report.criteria.every(criterion => criterion.status === 'validated');
  let finalBody = null;
  let finalExisting = false;
  let finalReason = null;
  const finalComments = issueCommentsWithMarker(comments, finalAssessmentMarker(parent.number));
  if (finalComments.length > 1) {
    return { valid: false, reason: 'final_assessment_conflict', childDelivery, children };
  }
  if (incompleteChildren.length > 0) finalReason = 'children_incomplete';
  else if (missingDelivery.length > 0) finalReason = 'child_delivery_evidence_missing';
  else if (!allCriteriaValidated) finalReason = 'criteria_not_validated';
  if (finalComments.length === 1 && finalReason) {
    return { valid: false, reason: 'final_assessment_conflict', childDelivery, children };
  }
  if (!finalReason) {
    finalBody = renderFinalAssessmentComment(report);
    if (finalComments.length === 1) {
      const parsed = parseFinalAssessmentComment(finalComments[0], {
        parentIssue: parent.number,
        criteria: parseAcceptanceChecklist(parent.body).items,
        childIssues: children.map(child => child.number),
      });
      if (!parsed || finalComments[0].body !== finalBody) {
        return { valid: false, reason: 'final_assessment_conflict', childDelivery, children };
      }
      finalExisting = true;
    }
  }

  return {
    valid: true,
    children,
    payloads,
    incompleteChildren,
    missingDelivery,
    allCriteriaValidated,
    childDelivery,
    finalBody,
    finalExisting,
    finalReason,
  };
}

function publicSummary(report, plan, { decision, reason, finalRecorded = false } = {}) {
  return {
    decision: decision ?? report.decision,
    parentIssue: report.parentIssue,
    childCount: report.childCount,
    canRecord: report.canRecord,
    ...(reason ?? report.reason ? { reason: reason ?? report.reason } : {}),
    ...(report.unassessedChildIssues ? { unassessedChildIssues: report.unassessedChildIssues } : {}),
    ...(report.conflictingPullRequestNumbers ? { conflictingPullRequestNumbers: report.conflictingPullRequestNumbers } : {}),
    criteria: criterionSummary(report.criteria),
    childDelivery: plan?.childDelivery ?? { pending: [], existing: [], missingEvidence: [], recorded: [] },
    finalAssessment: {
      eligible: plan?.finalBody !== null && plan?.finalBody !== undefined,
      wouldPost: plan?.finalBody !== null && plan?.finalBody !== undefined && !plan.finalExisting,
      recorded: finalRecorded || plan?.finalExisting === true,
      ...(plan?.finalReason ? { reason: plan.finalReason } : {}),
    },
  };
}

async function readParentSnapshot(client, parentIssue) {
  const parent = await client.getIssue(parentIssue);
  const childPages = await client.listSubIssuePages(parentIssue);
  const comments = await client.listIssueComments(parentIssue);
  return { parent, childPages, comments };
}

async function appendCommentAndVerify(client, parentIssue, marker, expectedBody) {
  if (typeof client.createIssueComment !== 'function') {
    throw new Error('Explicit issue-comment write capability is unavailable.');
  }
  const before = await client.listIssueComments(parentIssue);
  const already = issueCommentsWithMarker(before, marker);
  if (already.length > 0) {
    if (already.length === 1 && already[0].body === expectedBody) return already[0];
    throw new Error('A conflicting comment marker exists; reconcile before retrying.');
  }
  let writeError = null;
  try {
    await client.createIssueComment(parentIssue, expectedBody);
  } catch (error) {
    writeError = error;
  }
  let after;
  try {
    after = await client.listIssueComments(parentIssue);
  } catch (cause) {
    const error = new Error('Comment write outcome is uncertain; reread the complete issue-comment inventory before retrying.', { cause: writeError ?? cause });
    error.uncertainWrite = true;
    throw error;
  }
  const matches = issueCommentsWithMarker(after, marker);
  if (matches.length === 1 && matches[0].body === expectedBody) return matches[0];
  const error = new Error('Comment write did not read back uniquely; reconcile the issue-comment inventory before retrying.', { cause: writeError ?? undefined });
  error.uncertainWrite = true;
  throw error;
}

function incompleteResult(assessment, reason) {
  return publicSummary({
    decision: 'unable_to_assess', parentIssue: assessment?.parentIssue,
    childCount: undefined, canRecord: false, reason, criteria: [],
  }, null, { decision: 'unable_to_assess', reason });
}

/** Preview by default; --write appends child/final comments and never patches the parent body. */
export async function recordParentAcceptance(client, assessment, { write = false } = {}) {
  if (!isIssueNumber(assessment?.parentIssue)) return incompleteResult(assessment, 'invalid_assessment_data');
  let snapshot = await readParentSnapshot(client, assessment.parentIssue);
  let report = assessParentAcceptance({ parent: snapshot.parent, childPages: snapshot.childPages, assessment });
  if (!report.canRecord) return publicSummary(report, null);
  if (String(snapshot.parent.state).toLowerCase() !== 'open') {
    return publicSummary({ ...report, canRecord: false, reason: 'parent_not_open' }, null);
  }
  let plan = inspectCommentPlan(report, snapshot.parent, snapshot.childPages, snapshot.comments);
  if (!plan.valid) return publicSummary({ ...report, canRecord: false, reason: plan.reason }, plan);
  const initialBody = snapshot.parent.body;
  if (!write) {
    const decision = plan.incompleteChildren.length > 0 ? 'waiting_for_children'
      : plan.missingDelivery.length > 0 ? 'delivery_evidence_incomplete'
        : !plan.allCriteriaValidated ? 'assessment_incomplete'
          : plan.finalExisting ? 'accepted' : 'ready_to_record';
    return publicSummary(report, plan, { decision });
  }

  snapshot = await readParentSnapshot(client, assessment.parentIssue);
  if (snapshot.parent.body !== initialBody) return incompleteResult(assessment, 'parent_changed_before_recording');
  report = assessParentAcceptance({ parent: snapshot.parent, childPages: snapshot.childPages, assessment });
  if (!report.canRecord) return publicSummary(report, null);
  plan = inspectCommentPlan(report, snapshot.parent, snapshot.childPages, snapshot.comments);
  if (!plan.valid) return publicSummary({ ...report, canRecord: false, reason: plan.reason }, plan);

  const recorded = [];
  for (const childIssue of plan.childDelivery.pending) {
    const childComment = plan.payloads.get(childIssue);
    if (!childComment) continue;
    await appendCommentAndVerify(
      client,
      assessment.parentIssue,
      childDeliveryMarker(assessment.parentIssue, childIssue),
      childComment.body,
    );
    recorded.push(childIssue);
  }

  snapshot = await readParentSnapshot(client, assessment.parentIssue);
  if (snapshot.parent.body !== initialBody) {
    return publicSummary({ ...report, canRecord: true }, {
      ...plan,
      childDelivery: { ...plan.childDelivery, recorded },
      finalBody: null,
      finalExisting: false,
      finalReason: 'parent_changed_before_final_assessment',
    }, { decision: 'unable_to_assess', reason: 'parent_changed_before_final_assessment' });
  }
  report = assessParentAcceptance({ parent: snapshot.parent, childPages: snapshot.childPages, assessment });
  if (!report.canRecord) return publicSummary(report, null);
  plan = inspectCommentPlan(report, snapshot.parent, snapshot.childPages, snapshot.comments);
  plan.childDelivery.recorded = recorded;
  if (!plan.valid) return publicSummary({ ...report, canRecord: false, reason: plan.reason }, plan);
  if (String(snapshot.parent.state).toLowerCase() !== 'open') {
    return publicSummary({ ...report, canRecord: false, reason: 'parent_not_open' }, plan);
  }

  if (plan.incompleteChildren.length > 0) {
    return publicSummary(report, plan, { decision: 'waiting_for_children' });
  }
  if (plan.missingDelivery.length > 0) {
    return publicSummary(report, plan, { decision: 'delivery_evidence_incomplete' });
  }
  if (!plan.allCriteriaValidated) {
    return publicSummary(report, plan, { decision: 'assessment_incomplete' });
  }
  if (plan.finalExisting) return publicSummary(report, plan, { decision: 'accepted', finalRecorded: true });
  if (!plan.finalBody) return publicSummary(report, plan, { decision: 'assessment_incomplete' });

  await appendCommentAndVerify(
    client,
    assessment.parentIssue,
    finalAssessmentMarker(assessment.parentIssue),
    plan.finalBody,
  );
  const verified = await readParentSnapshot(client, assessment.parentIssue);
  if (verified.parent.body !== initialBody) {
    return publicSummary(report, {
      ...plan,
      childDelivery: { ...plan.childDelivery, recorded },
      finalBody: null,
      finalExisting: false,
      finalReason: 'parent_changed_after_final_assessment',
    }, { decision: 'unable_to_assess', reason: 'parent_changed_after_final_assessment' });
  }
  const verifiedReport = assessParentAcceptance({ parent: verified.parent, childPages: verified.childPages, assessment });
  const verifiedIndex = indexCoordinationParentComments(verified.comments, {
    parentIssue: assessment.parentIssue,
    criteria: parseAcceptanceChecklist(verified.parent.body).items,
    childIssues: verifiedReport.criteria.length > 0
      ? verified.childPages.flat().map(child => child.number)
      : [],
  });
  if (!verifiedReport.canRecord || !verifiedIndex.valid) {
    const error = new Error('Final assessment comment could not be verified against the current parent and child inventory.');
    error.uncertainWrite = true;
    throw error;
  }
  return publicSummary(verifiedReport, {
    ...plan,
    childDelivery: { ...plan.childDelivery, recorded },
    finalExisting: true,
    finalBody: plan.finalBody,
    finalReason: null,
  }, { decision: 'accepted', finalRecorded: true });
}

export function parseArguments(args) {
  const positional = [];
  let write = false;
  for (const argument of args) {
    if (argument === '--write' && !write) write = true;
    else if (argument.startsWith('--') || positional.length >= 2) {
      throw new Error('Usage: node .agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs ISSUE_NUMBER ASSESSMENT.json [--write]');
    } else positional.push(argument);
  }
  if (positional.length !== 2 || !/^[1-9]\d*$/.test(positional[0] ?? '')
    || !Number.isSafeInteger(Number(positional[0]))) {
    throw new Error('Usage: node .agents/skills/jarvis-project-management/scripts/github/coordination-parent-acceptance.mjs ISSUE_NUMBER ASSESSMENT.json [--write]');
  }
  return { issueNumber: Number(positional[0]), assessmentFile: positional[1], write };
}

export async function main(args = process.argv.slice(2), client = null, output = process.stdout) {
  const { issueNumber, assessmentFile, write } = parseArguments(args);
  let assessment;
  try {
    assessment = JSON.parse(readFileSync(assessmentFile, 'utf8'));
  } catch {
    throw new Error('Assessment file is missing or invalid JSON.');
  }
  if (!isObject(assessment) || assessment.parentIssue !== issueNumber) {
    throw new Error('Assessment issue does not match the selected issue.');
  }
  const github = client ?? createAcceptanceGitHubClient(runReviewedHelper, { writeEnabled: write });
  const result = await recordParentAcceptance(github, assessment, {
    write,
  });
  output.write(`${JSON.stringify(result)}\n`);
  return result.canRecord ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const network = appNetworkError(error) ?? appNetworkError(error.cause);
    if (network) {
      process.stderr.write(`${network.message}\n`);
      process.exitCode = NETWORK_EXIT_CODE;
    } else {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
    if (error.uncertainWrite) {
      process.stderr.write('Write outcome is not confirmed. Read the issue state before any retry.\n');
    }
  }
}
