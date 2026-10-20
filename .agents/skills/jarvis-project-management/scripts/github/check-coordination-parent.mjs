#!/usr/bin/env node
/** On-demand, read-only coordination-parent eligibility check. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { appNetworkError, NETWORK_EXIT_CODE } from './gh-app.mjs';

const REPOSITORY = 'grasdouble/Jarvis';
const REPOSITORY_PATH = 'repos/grasdouble/Jarvis';
const EXCLUDED_ISSUES = new Set([32]);
const API_HELPER = fileURLToPath(new URL('./gh-app.mjs', import.meta.url));

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIssueNumber = value => Number.isSafeInteger(value) && value > 0;

function invalidInventory() {
  throw new Error('Invalid GitHub issue data.');
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

function normalizeStateReason(issue) {
  const reason = issue?.state_reason ?? issue?.stateReason ?? null;
  return typeof reason === 'string' ? reason.toLowerCase() : reason;
}

function validIssue(issue, { requireBody = false } = {}) {
  return isObject(issue)
    && !Object.hasOwn(issue, 'pull_request')
    && isIssueNumber(issue.number)
    && ['open', 'closed'].includes(String(issue.state).toLowerCase())
    && repositoryIsJarvis(issue)
    && (!requireBody || typeof issue.body === 'string');
}

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

export function parseAcceptanceCriteria(body) {
  if (typeof body !== 'string') {
    return { valid: false, total: 0, unchecked: 0, reason: 'criteria_malformed' };
  }
  const { lines, malformed: malformedFence } = visibleMarkdownLines(body);
  if (malformedFence || lines.some(line => line !== null && (line.includes('<!--') || line.includes('-->')))) {
    return { valid: false, total: 0, unchecked: 0, reason: 'criteria_malformed' };
  }

  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const item = heading(lines[index]);
    if (item?.title.toLowerCase() === 'acceptance criteria') sections.push({ index, level: item.level });
  }
  if (sections.length === 0) return { valid: false, total: 0, unchecked: 0, reason: 'criteria_missing' };
  if (sections.length !== 1) return { valid: false, total: 0, unchecked: 0, reason: 'criteria_ambiguous' };

  const [{ index: start, level }] = sections;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const item = heading(lines[index]);
    if (item && item.level <= level) {
      end = index;
      break;
    }
  }

  let total = 0;
  let unchecked = 0;
  let malformed = false;
  const task = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[([^\]]*)\](?:[ \t]+(.*?))?\s*$/;
  for (const line of lines.slice(start + 1, end)) {
    if (line === null) continue;
    if (line.includes('<') || line.includes('>') || /^\s*>.*\[[ xX]?\]/.test(line)) {
      malformed = true;
      continue;
    }
    const match = line.match(task);
    if (!match) continue;
    const indentation = match[1];
    const marker = match[2];
    const description = match[3]?.trim() ?? '';
    if (indentation.includes('\t') || indentation.length >= 4
      || (marker !== ' ' && marker.toLowerCase() !== 'x') || description === '') {
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

function issueSummaryTotal(issue) {
  const summary = issue?.sub_issues_summary ?? issue?.subIssuesSummary;
  return isObject(summary) && Number.isSafeInteger(summary.total) && summary.total >= 0
    ? summary.total
    : null;
}

function validReasonForState(issue) {
  const reason = normalizeStateReason(issue);
  const state = String(issue.state).toLowerCase();
  if (state === 'open') return reason === null || reason === '' || reason === 'reopened';
  return ['completed', 'not_planned', 'duplicate'].includes(reason);
}

export function evaluateCoordinationParent({ issue, parent, childPages }) {
  if (!validIssue(issue) || !validReasonForState(issue)) {
    return { decision: 'unable_to_assess', reason: 'invalid_issue_data' };
  }
  if (EXCLUDED_ISSUES.has(issue.number)) return { decision: 'excluded', issue: issue.number };

  let target = parent;
  if (target === null) {
    const total = issueSummaryTotal(issue);
    if (total === null) return { decision: 'unable_to_assess', reason: 'invalid_parent_summary' };
    if (total === 0) return { decision: 'no_parent', issue: issue.number };
    target = issue;
  }
  if (!validIssue(target, { requireBody: true }) || !validReasonForState(target)) {
    return { decision: 'unable_to_assess', issue: issue.number, reason: 'invalid_parent_data' };
  }
  if (EXCLUDED_ISSUES.has(target.number)) return { decision: 'excluded', issue: issue.number, parent: target.number };
  if (parent !== null && target.number === issue.number) {
    return { decision: 'unable_to_assess', issue: issue.number, reason: 'invalid_parent_relationship' };
  }
  if (target.state.toLowerCase() !== 'open') {
    return { decision: 'not_eligible', issue: issue.number, parent: target.number, reason: 'parent_already_closed' };
  }
  if (!Array.isArray(childPages) || childPages.length === 0 || childPages.some(page => !Array.isArray(page))) {
    return { decision: 'unable_to_assess', issue: issue.number, parent: target.number, reason: 'incomplete_child_inventory' };
  }

  const children = childPages.flat();
  const expectedCount = issueSummaryTotal(target);
  const numbers = children.map(child => child?.number);
  if (expectedCount === null || numbers.some(number => !isIssueNumber(number))
    || new Set(numbers).size !== numbers.length || children.length !== expectedCount) {
    return {
      decision: 'unable_to_assess', issue: issue.number, parent: target.number,
      reason: 'incomplete_child_inventory', childCount: children.length,
      ...(expectedCount === null ? {} : { expectedChildCount: expectedCount }),
    };
  }
  if (children.length === 0) {
    return { decision: 'not_eligible', issue: issue.number, parent: target.number, reason: 'no_native_children' };
  }
  if (target.number !== issue.number && !numbers.includes(issue.number)) {
    return { decision: 'unable_to_assess', issue: issue.number, parent: target.number, reason: 'invalid_parent_relationship' };
  }

  for (const child of children) {
    if (!validIssue(child) || !validReasonForState(child)) {
      return { decision: 'unable_to_assess', issue: issue.number, parent: target.number, reason: 'invalid_child_data' };
    }
  }
  const incompleteChildren = children.filter(child => child.state.toLowerCase() !== 'closed'
    || normalizeStateReason(child) !== 'completed').length;
  if (incompleteChildren > 0) {
    return {
      decision: 'not_eligible', issue: issue.number, parent: target.number,
      reason: 'children_incomplete', childCount: children.length, incompleteChildren,
    };
  }

  const criteria = parseAcceptanceCriteria(target.body);
  if (!criteria.valid) {
    return {
      decision: 'not_eligible', issue: issue.number, parent: target.number,
      reason: criteria.reason, childCount: children.length,
      criterionCount: criteria.total, uncheckedCriteria: criteria.unchecked,
    };
  }
  return {
    decision: 'eligible_to_close', issue: issue.number, parent: target.number,
    childCount: children.length, criterionCount: criteria.total,
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

function gh(args) {
  try {
    return execFileSync(process.execPath, [API_HELPER, '--', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: helperEnvironment(),
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const network = appNetworkError(error);
    if (network) throw network;
    throw new Error('GitHub read failed; inspect access or service availability.');
  }
}

function apiJson(runGh, args) {
  const output = runGh(['api', ...args]);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub returned invalid or unavailable issue data.');
  }
}

export function createGitHubClient(runGh = gh) {
  return {
    getIssue(number) {
      return apiJson(runGh, [`${REPOSITORY_PATH}/issues/${number}`]);
    },
    getParentNumber(number) {
      const view = JSON.parse(runGh([
        'issue', 'view', String(number), '--repo', REPOSITORY,
        '--json', 'parent',
      ]));
      if (!isObject(view) || !Object.hasOwn(view, 'parent')) invalidInventory();
      if (view.parent === null) return null;
      if (!isObject(view.parent) || !isIssueNumber(view.parent.number)) invalidInventory();
      return view.parent.number;
    },
    listSubIssuePages(number) {
      return apiJson(runGh, [
        '--method', 'GET', '--paginate', '--slurp',
        `${REPOSITORY_PATH}/issues/${number}/sub_issues?per_page=100`,
      ]);
    },
  };
}

function loadGitHubClient() {
  return createGitHubClient();
}

export async function checkIssue(client, number) {
  if (!isIssueNumber(number)) return { decision: 'unable_to_assess', reason: 'invalid_issue_number' };
  if (EXCLUDED_ISSUES.has(number)) return { decision: 'excluded', issue: number };
  const issue = await client.getIssue(number);
  if (!validIssue(issue) || !validReasonForState(issue)) {
    return { decision: 'unable_to_assess', issue: number, reason: 'invalid_issue_data' };
  }

  const parentNumber = await client.getParentNumber(number);
  let parent = null;
  if (parentNumber !== null) {
    if (!isIssueNumber(parentNumber) || parentNumber === number) {
      return { decision: 'unable_to_assess', issue: number, reason: 'invalid_parent_relationship' };
    }
    if (EXCLUDED_ISSUES.has(parentNumber)) return { decision: 'excluded', issue: number, parent: parentNumber };
    parent = await client.getIssue(parentNumber);
  } else {
    const childCount = issueSummaryTotal(issue);
    if (childCount === null) {
      return { decision: 'unable_to_assess', issue: number, reason: 'invalid_parent_summary' };
    }
    if (childCount === 0) return { decision: 'no_parent', issue: number };
  }

  const targetNumber = parent?.number ?? issue.number;
  const childPages = await client.listSubIssuePages(targetNumber);
  return evaluateCoordinationParent({ issue, parent, childPages });
}

function parseIssueNumber(raw) {
  if (!/^[1-9]\d*$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Usage: node .agents/skills/jarvis-project-management/scripts/github/check-coordination-parent.mjs ISSUE_NUMBER');
  }
  return Number(raw);
}

export async function main(args = process.argv.slice(2), client = loadGitHubClient()) {
  if (args.length !== 1) throw new Error('Usage: node .agents/skills/jarvis-project-management/scripts/github/check-coordination-parent.mjs ISSUE_NUMBER');
  const result = await checkIssue(client, parseIssueNumber(args[0]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.decision === 'unable_to_assess' ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const network = appNetworkError(error);
    if (network) {
      process.stderr.write(`${network.message}\n`);
      process.exitCode = NETWORK_EXIT_CODE;
    } else {
      process.stderr.write('Coordination-parent check could not complete; no issue was changed.\n');
      process.exitCode = 2;
    }
  }
}
