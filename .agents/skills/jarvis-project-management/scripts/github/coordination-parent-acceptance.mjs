#!/usr/bin/env node
/** Record a caller's evidence-backed coordination-parent acceptance assessment. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { appNetworkError, NETWORK_EXIT_CODE } from './gh-app.mjs';

const REPOSITORY_PATH = 'repos/grasdouble/Jarvis';
const API_HELPER = fileURLToPath(new URL('./gh-app.mjs', import.meta.url));
const GENERATED_START = '<!-- jarvis-coordination-parent-acceptance:start -->';
const GENERATED_END = '<!-- jarvis-coordination-parent-acceptance:end -->';
const STATUSES = new Set(['validated', 'not_yet_validated', 'unable_to_assess']);
const OUTCOME_KINDS = new Set(['child', 'integration', 'direct']);
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

/** Preserve the structural checker's original compact parse result. */
export function parseAcceptanceCriteria(body) {
  const parsed = parseAcceptanceChecklist(body);
  const { lines, malformed: malformedFence } = typeof body === 'string'
    ? visibleMarkdownLines(body)
    : { lines: [], malformed: true };
  if (malformedFence) {
    return { valid: false, total: parsed.total, unchecked: parsed.unchecked, reason: 'criteria_malformed' };
  }

  const startIndexes = [];
  const endIndexes = [];
  lines.forEach((line, index) => {
    if (line === GENERATED_START) startIndexes.push(index);
    if (line === GENERATED_END) endIndexes.push(index);
  });
  const hasOwnedMarker = startIndexes.length > 0 || endIndexes.length > 0;
  const ownedBlockIsValid = !hasOwnedMarker
    || (startIndexes.length === 1
      && endIndexes.length === 1
      && startIndexes[0] > 0
      && startIndexes[0] < endIndexes[0]
      && Number.isInteger(parsed.sectionLevel)
      && lines[startIndexes[0] - 1] === `${'#'.repeat(parsed.sectionLevel)} Parent acceptance assessment evidence`);
  const unmanagedComment = lines.some(line => line !== null
    && (line.includes('<!--') || line.includes('-->'))
    && line !== GENERATED_START
    && line !== GENERATED_END);
  if (!ownedBlockIsValid || unmanagedComment) {
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
  if (parsed.unchecked > 0) {
    return {
      valid: false,
      total: parsed.total,
      unchecked: parsed.unchecked,
      reason: 'criteria_unchecked',
    };
  }
  return { valid: true, total: parsed.total, unchecked: 0 };
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
    if (kind === 'direct' && item.childIssue !== undefined) return { valid: false, evidence: [] };
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
  if (outcome.kind === 'direct' && outcome.childIssues.length !== 0) {
    return { ...result, reason: 'direct_outcome_mapping_invalid' };
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
  if (!structuralCriteria.valid && structuralCriteria.reason !== 'criteria_unchecked') {
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
  const criteria = checklist.items.map(item => assessedCriterion(item, entries.get(item.index), inventory.children));
  return {
    decision: 'assessed',
    parentIssue: parent.number,
    childCount: inventory.children.size,
    sectionLevel: checklist.sectionLevel,
    canRecord: true,
    criteria,
  };
}

function markdownText(value) {
  const special = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '!', '<', '>', '|']);
  return [...String(value).replace(/\s+/g, ' ').trim()]
    .map(character => special.has(character) ? `\\${character}` : character)
    .join('');
}

function acceptanceEvidenceBlock(report) {
  const headingPrefix = '#'.repeat(report.sectionLevel);
  const lines = [
    `${headingPrefix} Parent acceptance assessment evidence`,
    GENERATED_START,
    '**Latest criterion-by-criterion acceptance assessment**',
  ];
  for (const criterion of report.criteria) {
    lines.push(`- Criterion ${criterion.index}: **${criterion.status.replaceAll('_', ' ')}**`);
    if (criterion.reason) lines.push(`  - Assessment: ${markdownText(criterion.reason)}.`);
    if (criterion.scopeEvolution) {
      lines.push(`  - Previous wording: ${markdownText(criterion.scopeEvolution.previousText)}`);
      lines.push(`  - Authorized scope evolution: ${markdownText(criterion.scopeEvolution.rationale)} Source: <${criterion.scopeEvolution.authorizationUrl}>.`);
    }
    for (const outcome of criterion.outcomes) {
      lines.push(`  - Outcome: ${markdownText(outcome.description)} (${outcome.status.replaceAll('_', ' ')}).`);
      if (outcome.childIssues.length > 0) {
        lines.push(`    - Native children: ${outcome.childIssues.map(number => `#${number}`).join(', ')}.`);
      }
      for (const source of outcome.evidence) {
        const revisionDetails = [
          ...(source.revision ? [`revision ${source.revision}`] : []),
          ...(source.reviewedRevision ? [`reviewed head ${source.reviewedRevision}`] : []),
        ];
        const details = [source.sourceType, source.status, ...revisionDetails].join('; ');
        const childDetails = source.childIssue === undefined ? [] : [`child #${source.childIssue}`];
        lines.push(`    - Evidence: ${markdownText([...childDetails, details].join('; '))}; ${markdownText(source.label)} — <${source.url}>.`);
      }
      if (outcome.reason) lines.push(`    - Assessment: ${markdownText(outcome.reason)}.`);
      if (outcome.rationale) lines.push(`    - Rationale: ${markdownText(outcome.rationale)}.`);
    }
  }
  lines.push(GENERATED_END);
  return lines;
}

/** Update only checklist markers, explicitly authorized criterion wording, and the owned evidence block. */
export function updateAcceptanceBody(body, report) {
  if (!report?.canRecord || !Array.isArray(report.criteria)) {
    throw new Error('Parent acceptance assessment is incomplete; no body can be prepared.');
  }
  const parsed = parseAcceptanceChecklist(body);
  if (!parsed.valid || parsed.items.length !== report.criteria.length) {
    throw new Error('Parent acceptance checklist changed; reread and reassess before recording.');
  }
  const structuralCriteria = parseAcceptanceCriteria(body);
  if (!structuralCriteria.valid && structuralCriteria.reason !== 'criteria_unchecked') {
    throw new Error('Parent acceptance body contains malformed or unmanaged markup; no body can be prepared.');
  }
  const criteria = new Map(report.criteria.map(item => [item.index, item]));
  const lines = body.split(/\r?\n/);
  for (const item of parsed.items) {
    const result = criteria.get(item.index);
    if (!result || !STATUSES.has(result.status)) {
      throw new Error('Parent acceptance assessment does not match the current checklist.');
    }
    if (result.text !== item.text
      && (!result.scopeEvolution || result.scopeEvolution.previousText !== item.text || !result.scopeEvolution.replaceText)) {
      throw new Error('Parent acceptance criterion changed without an authorized scope-evolution record.');
    }
    const line = lines[item.lineIndex];
    const marker = result.status === 'validated' ? 'x' : ' ';
    let updated = `${line.slice(0, item.markerIndex)}${marker}${line.slice(item.markerIndex + 1)}`;
    if (result.text !== item.text) {
      updated = `${updated.slice(0, item.textStart)}${result.text}${updated.slice(item.textEnd)}`;
    }
    lines[item.lineIndex] = updated;
  }

  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const startIndexes = [];
  const endIndexes = [];
  lines.forEach((line, index) => {
    if (line === GENERATED_START) startIndexes.push(index);
    if (line === GENERATED_END) endIndexes.push(index);
  });
  if (startIndexes.length !== endIndexes.length || startIndexes.length > 1
    || (startIndexes.length === 1 && startIndexes[0] >= endIndexes[0])) {
    throw new Error('Existing parent acceptance evidence block is ambiguous; no body can be prepared.');
  }

  const evidenceLines = acceptanceEvidenceBlock(report);
  if (startIndexes.length === 1) {
    const headingIndex = startIndexes[0] - 1;
    const expectedHeading = `${'#'.repeat(parsed.sectionLevel)} Parent acceptance assessment evidence`;
    if (lines[headingIndex] !== expectedHeading) {
      throw new Error('Existing parent acceptance evidence block is ambiguous; no body can be prepared.');
    }
    lines.splice(headingIndex, endIndexes[0] - headingIndex + 1, ...evidenceLines);
    return lines.join(newline);
  }
  if (lines.includes(`${'#'.repeat(parsed.sectionLevel)} Parent acceptance assessment evidence`)) {
    throw new Error('An unmanaged parent acceptance evidence heading already exists; no body can be prepared.');
  }
  const nextBody = lines.join(newline);
  const separator = nextBody.endsWith(newline) ? newline : `${newline}${newline}`;
  return `${nextBody}${separator}${evidenceLines.join(newline)}`;
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
  };
  if (writeEnabled) {
    client.updateIssueBody = (number, body) => {
      runGh([
        'api', '--method', 'PATCH', `${REPOSITORY_PATH}/issues/${number}`,
        '--raw-field', `body=${body}`,
      ], { write: true });
    };
  }
  return client;
}

function publicSummary(report, { recorded = false, wouldChange = false } = {}) {
  return {
    decision: report.decision,
    parentIssue: report.parentIssue,
    childCount: report.childCount,
    canRecord: report.canRecord,
    ...(report.reason ? { reason: report.reason } : {}),
    criteria: report.criteria.map(criterion => ({
      index: criterion.index,
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
        status: outcome.status,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        childIssues: outcome.childIssues,
        evidence: outcome.evidence,
        ...(outcome.rationale ? { rationale: outcome.rationale } : {}),
      })),
    })),
    recorded,
    wouldChange,
  };
}

/** Preview by default. `write: true` is an explicit caller authorization to update the issue body only. */
export async function recordParentAcceptance(client, assessment, { write = false } = {}) {
  if (!isIssueNumber(assessment?.parentIssue)) {
    return publicSummary({
      decision: 'unable_to_assess', parentIssue: undefined, childCount: undefined,
      canRecord: false, reason: 'invalid_assessment_data', criteria: [],
    });
  }
  let parent = await client.getIssue(assessment.parentIssue);
  let childPages = await client.listSubIssuePages(assessment.parentIssue);
  let report = assessParentAcceptance({ parent, childPages, assessment });
  if (!report.canRecord) return publicSummary(report);
  let nextBody = updateAcceptanceBody(parent.body, report);
  let wouldChange = nextBody !== parent.body;
  if (!write) return publicSummary(report, { wouldChange });

  const originalBody = parent.body;
  parent = await client.getIssue(assessment.parentIssue);
  childPages = await client.listSubIssuePages(assessment.parentIssue);
  if (parent.body !== originalBody) {
    return publicSummary({
      decision: 'unable_to_assess', parentIssue: parent.number,
      canRecord: false, reason: 'parent_changed_before_write', criteria: [],
    });
  }
  report = assessParentAcceptance({ parent, childPages, assessment });
  if (!report.canRecord) return publicSummary(report);
  nextBody = updateAcceptanceBody(parent.body, report);
  wouldChange = nextBody !== parent.body;
  if (String(parent.state).toLowerCase() !== 'open') {
    return publicSummary({ ...report, canRecord: false, reason: 'parent_not_open' });
  }
  if (!wouldChange) return publicSummary(report, { recorded: true, wouldChange: false });
  if (typeof client.updateIssueBody !== 'function') {
    throw new Error('Explicit issue-body write capability is unavailable.');
  }

  try {
    await client.updateIssueBody(parent.number, nextBody);
  } catch (cause) {
    const error = new Error('Parent acceptance update outcome is uncertain; reread the issue before retrying.', { cause });
    error.uncertainWrite = true;
    throw error;
  }
  let current;
  try {
    current = await client.getIssue(parent.number);
  } catch (cause) {
    const error = new Error('Parent acceptance update may have succeeded; reread the issue before retrying.', { cause });
    error.uncertainWrite = true;
    throw error;
  }
  if (current.body !== nextBody) {
    const error = new Error('Parent acceptance update did not read back exactly; reconcile before retrying.');
    error.uncertainWrite = true;
    throw error;
  }
  return publicSummary(report, { recorded: true, wouldChange: true });
}

function parseArguments(args) {
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
  const result = await recordParentAcceptance(github, assessment, { write });
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
