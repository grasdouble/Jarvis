#!/usr/bin/env node
/** On-demand, read-only structural coordination-parent eligibility check. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { appNetworkError, NETWORK_EXIT_CODE } from './gh-app.mjs';
import { parseAcceptanceChecklist, parseAcceptanceCriteria } from './coordination-parent-acceptance.mjs';
import { indexCoordinationParentComments } from './coordination-parent-comments.mjs';

export { parseAcceptanceCriteria };

const REPOSITORY = 'grasdouble/Jarvis';
const REPOSITORY_PATH = 'repos/grasdouble/Jarvis';
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

export function evaluateCoordinationParent({ issue, parent, childPages, comments = [] }) {
  if (!validIssue(issue) || !validReasonForState(issue)) {
    return { decision: 'unable_to_assess', reason: 'invalid_issue_data' };
  }

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
  const checklist = parseAcceptanceChecklist(target.body);
  if (!checklist.valid) {
    return {
      decision: 'not_eligible', issue: issue.number, parent: target.number,
      reason: checklist.reason, childCount: children.length,
      criterionCount: criteria.total, uncheckedCriteria: criteria.unchecked,
    };
  }
  const assessment = indexCoordinationParentComments(comments, {
    parentIssue: target.number,
    criteria: checklist.items,
    childIssues: numbers,
  });
  if (!assessment.valid) {
    return {
      decision: 'not_eligible', issue: issue.number, parent: target.number,
      reason: assessment.reason, childCount: children.length, criterionCount: criteria.total,
      uncheckedCriteria: criteria.unchecked,
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
    listIssueComments(number) {
      const pages = apiJson(runGh, [
        '--method', 'GET', '--paginate', '--slurp',
        `${REPOSITORY_PATH}/issues/${number}/comments?per_page=100`,
      ]);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) invalidInventory();
      return pages.flat();
    },
  };
}

function loadGitHubClient() {
  return createGitHubClient();
}

export async function checkIssue(client, number) {
  if (!isIssueNumber(number)) return { decision: 'unable_to_assess', reason: 'invalid_issue_number' };
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
  const comments = await client.listIssueComments(targetNumber);
  return evaluateCoordinationParent({ issue, parent, childPages, comments });
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
