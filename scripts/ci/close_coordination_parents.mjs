import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const REPOSITORY_PATH = '/repos/grasdouble/Jarvis';
const MAX_PAGES = 100;
const STATE_REASONS = new Set([null, 'completed', 'reopened', 'not_planned', 'duplicate']);
const ACTIONS = new Set(['edited', 'closed', 'reopened']);

export class GitHubApiError extends Error {
  constructor(operation, status = null, reason = 'request_failed') {
    super('GitHub API request failed.');
    this.name = 'GitHubApiError';
    this.operation = operation;
    this.status = Number.isInteger(status) ? status : null;
    this.reason = reason;
  }
}

function scopedRepository(issue) {
  if (typeof issue?.repository_url !== 'string') return false;
  try {
    const url = new URL(issue.repository_url);
    return url.origin === API_ORIGIN && url.pathname.toLowerCase() === REPOSITORY_PATH.toLowerCase();
  } catch {
    return false;
  }
}

function assertIssueResponse(issue, expectedNumber, operation) {
  if (!issue || typeof issue !== 'object'
    || !Number.isSafeInteger(issue.number) || issue.number < 1
    || (expectedNumber !== undefined && issue.number !== expectedNumber)
    || !scopedRepository(issue)) {
    throw new GitHubApiError(operation, null, 'invalid_response');
  }
  return issue;
}

function extractNextLink(linkHeader, expectedPath) {
  if (!linkHeader) return null;
  const links = [];
  const expression = /<([^<>]+)>\s*;\s*rel=(?:"([^"]+)"|([^\s,]+))/g;
  for (const match of linkHeader.matchAll(expression)) {
    if ((match[2] ?? match[3]) === 'next') links.push(match[1]);
  }
  if (links.length > 1 || (links.length === 0 && /\brel\s*=\s*"?next\b/i.test(linkHeader))) {
    throw new GitHubApiError('paginate sub-issues', null, 'invalid_pagination');
  }
  if (links.length === 0) return null;

  let next;
  try {
    next = new URL(links[0], API_ORIGIN);
  } catch {
    throw new GitHubApiError('paginate sub-issues', null, 'invalid_pagination');
  }
  if (next.origin !== API_ORIGIN || next.pathname !== expectedPath
    || next.searchParams.get('per_page') !== '100' || next.hash) {
    throw new GitHubApiError('paginate sub-issues', null, 'invalid_pagination');
  }
  return next.href;
}

export function createGitHubClient({ token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || token.trim() === '' || typeof fetchImpl !== 'function') {
    throw new TypeError('A GitHub token and fetch implementation are required.');
  }

  async function request(pathOrUrl, {
    method = 'GET',
    body,
    allowNotFound = false,
    operation = `${method} issue API`,
  } = {}) {
    let url;
    try {
      url = new URL(pathOrUrl, API_ORIGIN);
    } catch {
      throw new GitHubApiError(`${method} request`, null, 'invalid_url');
    }
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith(`${REPOSITORY_PATH}/issues/`)) {
      throw new GitHubApiError(`${method} request`, null, 'out_of_scope_url');
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'Jarvis-coordination-parent-closure',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GitHubApiError(operation, null, 'transport_failure');
    }

    if (allowNotFound && response.status === 404) {
      return { status: response.status, data: null, headers: response.headers };
    }
    if (!response.ok) throw new GitHubApiError(operation, response.status, 'http_failure');

    let data;
    try {
      data = await response.json();
    } catch {
      throw new GitHubApiError(operation, response.status, 'invalid_json');
    }
    return { status: response.status, data, headers: response.headers };
  }

  async function getIssue(number) {
    const path = `${REPOSITORY_PATH}/issues/${number}`;
    const { data } = await request(path, { operation: 'read issue' });
    return assertIssueResponse(data, number, 'read issue');
  }

  async function getParent(number) {
    const path = `${REPOSITORY_PATH}/issues/${number}/parent`;
    const { data } = await request(path, { allowNotFound: true, operation: 'read native parent' });
    if (data === null) return null;
    return assertIssueResponse(data, undefined, 'read native parent');
  }

  async function listSubIssues(number) {
    const path = `${REPOSITORY_PATH}/issues/${number}/sub_issues`;
    let next = `${API_ORIGIN}${path}?per_page=100`;
    const visited = new Set();
    const issues = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (visited.has(next)) throw new GitHubApiError('paginate sub-issues', null, 'pagination_loop');
      visited.add(next);
      const { data, headers } = await request(next, { operation: 'read sub-issues' });
      if (!Array.isArray(data)) throw new GitHubApiError('read sub-issues', null, 'invalid_response');
      for (const issue of data) issues.push(assertIssueResponse(issue, undefined, 'read sub-issues'));

      next = extractNextLink(headers.get('link'), path);
      if (next === null) {
        const numbers = issues.map((issue) => issue.number);
        if (new Set(numbers).size !== numbers.length) {
          throw new GitHubApiError('paginate sub-issues', null, 'duplicate_page_content');
        }
        return issues;
      }
    }
    throw new GitHubApiError('paginate sub-issues', null, 'page_limit_exceeded');
  }

  async function closeIssue(number) {
    const path = `${REPOSITORY_PATH}/issues/${number}`;
    const { data } = await request(path, {
      method: 'PATCH',
      operation: 'close parent issue',
      body: { state: 'closed', state_reason: 'completed' },
    });
    const issue = assertIssueResponse(data, number, 'close parent issue');
    if (issue.state !== 'closed' || issue.state_reason !== 'completed') {
      throw new GitHubApiError('verify closed parent', null, 'invalid_response');
    }
    return issue;
  }

  return { getIssue, getParent, listSubIssues, closeIssue };
}

function visibleMarkdownLines(body) {
  const visible = [];
  let fence = null;
  let inComment = false;

  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
      if (closing.test(line)) fence = null;
      visible.push(null);
      continue;
    }

    let remaining = line;
    let cleaned = '';
    while (remaining.length > 0) {
      if (inComment) {
        const closingComment = remaining.indexOf('-->');
        if (closingComment < 0) {
          remaining = '';
          break;
        }
        remaining = remaining.slice(closingComment + 3);
        inComment = false;
        continue;
      }
      const openingComment = remaining.indexOf('<!--');
      if (openingComment < 0) {
        cleaned += remaining;
        remaining = '';
        break;
      }
      cleaned += remaining.slice(0, openingComment);
      remaining = remaining.slice(openingComment + 4);
      inComment = true;
    }

    const opening = cleaned.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      visible.push(null);
      continue;
    }
    visible.push(cleaned);
  }
  return { lines: visible, malformed: fence !== null || inComment };
}

function parseHeading(line) {
  const match = line?.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)\s*$/);
  if (!match) return null;
  const title = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { level: match[1].length, title };
}

export function parseAcceptanceCriteria(body) {
  if (typeof body !== 'string') return { valid: false, total: 0, unchecked: 0, reason: 'criteria_malformed' };
  const { lines, malformed: malformedBody } = visibleMarkdownLines(body);
  if (malformedBody) return { valid: false, total: 0, unchecked: 0, reason: 'criteria_malformed' };
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (heading?.title.toLowerCase() === 'acceptance criteria') {
      sections.push({ index, level: heading.level });
    }
  }
  if (sections.length === 0) return { valid: false, total: 0, unchecked: 0, reason: 'criteria_missing' };
  if (sections.length > 1) return { valid: false, total: 0, unchecked: 0, reason: 'criteria_ambiguous' };

  const [{ index: start, level }] = sections;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (heading && heading.level <= level) {
      end = index;
      break;
    }
  }

  let total = 0;
  let unchecked = 0;
  let malformed = false;
  const taskLike = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[([^\]]*)\](?:[ \t]+(.*?))?\s*$/;
  for (const line of lines.slice(start + 1, end)) {
    if (line === null) continue;
    const match = line.match(taskLike);
    if (!match) continue;
    const indentation = match[1];
    const marker = match[2];
    const description = match[3]?.trim() ?? '';
    if (indentation.includes('\t') || indentation.length >= 4) {
      malformed = true;
      continue;
    }
    if ((marker !== ' ' && marker.toLowerCase() !== 'x') || description === '') {
      malformed = true;
      continue;
    }
    total += 1;
    if (marker === ' ') unchecked += 1;
  }

  if (malformed) return { valid: false, total, unchecked, reason: 'criteria_malformed' };
  if (total === 0) return { valid: false, total, unchecked, reason: 'criteria_empty' };
  if (unchecked > 0) return { valid: false, total, unchecked, reason: 'criteria_unchecked' };
  return { valid: true, total, unchecked: 0 };
}

function isAllowedStateReason(reason) {
  return STATE_REASONS.has(reason);
}

export function evaluateParent(parent, children) {
  if (!parent || typeof parent !== 'object' || parent.pull_request || !scopedRepository(parent)) {
    return { eligible: false, reason: 'not_a_native_parent' };
  }
  if (parent.state !== 'open') return { eligible: false, reason: 'parent_already_closed' };
  if (!Array.isArray(children) || !parent.sub_issues_summary
    || !Number.isSafeInteger(parent.sub_issues_summary.total) || parent.sub_issues_summary.total < 0) {
    return { eligible: false, reason: 'incomplete_child_inventory' };
  }

  const nativeChildren = children.filter((childIssue) => !childIssue?.pull_request);
  const childNumbers = nativeChildren.map((childIssue) => childIssue?.number);
  if (new Set(childNumbers).size !== childNumbers.length
    || childNumbers.length !== parent.sub_issues_summary.total) {
    return {
      eligible: false,
      reason: 'incomplete_child_inventory',
      childCount: childNumbers.length,
      expectedChildCount: parent.sub_issues_summary.total,
    };
  }
  if (nativeChildren.length === 0) return { eligible: false, reason: 'no_native_children' };

  let incompleteChildren = 0;
  for (const childIssue of nativeChildren) {
    if (!childIssue || typeof childIssue !== 'object'
      || !Number.isSafeInteger(childIssue.number) || childIssue.number < 1
      || !scopedRepository(childIssue)
      || !['open', 'closed'].includes(childIssue.state)
      || !isAllowedStateReason(childIssue.state_reason)) {
      return { eligible: false, reason: 'invalid_child_state' };
    }
    if (childIssue.state !== 'closed' || childIssue.state_reason !== 'completed') incompleteChildren += 1;
  }
  if (incompleteChildren > 0) return { eligible: false, reason: 'children_incomplete', incompleteChildren };

  const criteria = parseAcceptanceCriteria(parent.body);
  if (!criteria.valid) {
    return {
      eligible: false,
      reason: criteria.reason,
      criterionCount: criteria.total,
      uncheckedCriteria: criteria.unchecked,
    };
  }
  return { eligible: true, childCount: nativeChildren.length, criterionCount: criteria.total };
}

function sameParentSnapshot(before, after) {
  return before.number === after.number
    && before.state === after.state
    && before.state_reason === after.state_reason
    && before.body === after.body
    && before.updated_at === after.updated_at
    && before.sub_issues_summary?.total === after.sub_issues_summary?.total;
}

async function checkCurrentParent(client, number) {
  const before = await client.getIssue(number);
  if (before.pull_request) return { eligible: false, reason: 'not_a_native_parent' };
  if (before.state !== 'open') return { eligible: false, reason: 'parent_already_closed' };

  const children = await client.listSubIssues(number);
  const after = await client.getIssue(number);
  if (!sameParentSnapshot(before, after)) {
    return { eligible: false, reason: 'parent_changed_during_evaluation' };
  }
  return evaluateParent(after, children);
}

function emit(report, decision, reason, issueNumber, details = {}) {
  report({ decision, reason, issue: issueNumber, ...details });
}

export async function runIssueEvent(event, client, report = () => {}) {
  const action = event?.action;
  const eventIssue = event?.issue;
  if (!ACTIONS.has(action) || !Number.isSafeInteger(eventIssue?.number) || eventIssue.number < 1) {
    emit(report, 'skipped', 'irrelevant_event', null);
    return;
  }
  if (eventIssue.pull_request) {
    emit(report, 'skipped', 'pull_request_event', eventIssue.number);
    return;
  }

  const source = await client.getIssue(eventIssue.number);
  if (source.pull_request) {
    emit(report, 'skipped', 'pull_request_event', eventIssue.number);
    return;
  }
  const candidates = new Set();
  if (action === 'edited') {
    if (!Object.hasOwn(event?.changes ?? {}, 'body')) {
      emit(report, 'skipped', 'irrelevant_edit', eventIssue.number);
      return;
    }
    candidates.add(eventIssue.number);
  } else {
    const parent = await client.getParent(eventIssue.number);
    if (parent !== null) {
      if (!Number.isSafeInteger(parent?.number) || parent.number < 1 || parent.number === eventIssue.number) {
        throw new GitHubApiError('read native parent', null, 'invalid_response');
      }
      candidates.add(parent.number);
    }
  }
  if (candidates.size === 0) {
    emit(report, 'skipped', 'no_native_parent_or_children_to_check', eventIssue.number);
    return;
  }

  for (const number of candidates) {
    const initial = await checkCurrentParent(client, number);
    if (!initial.eligible) {
      emit(report, 'skipped', initial.reason, number, {
        childCount: initial.childCount,
        expectedChildCount: initial.expectedChildCount,
        incompleteChildren: initial.incompleteChildren,
        criterionCount: initial.criterionCount,
        uncheckedCriteria: initial.uncheckedCriteria,
      });
      continue;
    }

    // Re-read all eligibility inputs immediately before the write. GitHub has no
    // atomic close-if-children-and-body-still-match operation.
    const current = await checkCurrentParent(client, number);
    if (!current.eligible) {
      emit(report, 'skipped', current.reason, number, {
        childCount: current.childCount,
        expectedChildCount: current.expectedChildCount,
        incompleteChildren: current.incompleteChildren,
        criterionCount: current.criterionCount,
        uncheckedCriteria: current.uncheckedCriteria,
      });
      continue;
    }

    const closed = await client.closeIssue(number);
    if (closed?.state !== 'closed' || closed.state_reason !== 'completed') {
      throw new GitHubApiError('verify closed parent', null, 'invalid_response');
    }
    emit(report, 'closed', 'acceptance_and_children_verified', number, {
      childCount: current.childCount,
      criterionCount: current.criterionCount,
    });
  }
}

function diagnosticLog(entry) {
  console.log(`coordination-parent-close ${JSON.stringify(entry)}`);
}

export function errorDiagnostic(error, issueNumber) {
  const issue = Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
  if (error instanceof GitHubApiError) {
    return {
      decision: 'error',
      reason: error.reason,
      operation: error.operation,
      ...(error.status === null ? {} : { status: error.status }),
      ...(issue === null ? {} : { issue }),
    };
  }
  return { decision: 'error', reason: 'automation_failed', ...(issue === null ? {} : { issue }) };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (typeof token !== 'string' || token.trim() === '' || typeof eventPath !== 'string' || eventPath.trim() === '') {
    diagnosticLog({ decision: 'error', reason: 'missing_workflow_input' });
    process.exitCode = 1;
    return;
  }

  let event;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    diagnosticLog({ decision: 'error', reason: 'invalid_event_payload' });
    process.exitCode = 1;
    return;
  }

  const client = createGitHubClient({ token });
  try {
    await runIssueEvent(event, client, diagnosticLog);
  } catch (error) {
    diagnosticLog(errorDiagnostic(error, event?.issue?.number));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
