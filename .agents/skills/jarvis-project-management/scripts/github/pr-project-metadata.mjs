export const CONFIG = Object.freeze({
  repository: 'grasdouble/Jarvis',
  owner: 'grasdouble',
  projectNumber: 1,
  projectId: 'PVT_kwDOAvfTzc4BnQz1',
  fieldId: 'PVTF_lADOAvfTzc4BnQz1zhl_aaw',
  fieldName: 'Issue',
});

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const repositoryName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value);

function requireValid(condition, path) {
  if (!condition) throw new TypeError(`Invalid ${path}.`);
}

function validateMilestone(value, path) {
  if (value === null) return;
  requireValid(record(value), path);
  requireValid(nonempty(value.id), `${path}.id`);
  requireValid(positiveInteger(value.number), `${path}.number`);
  requireValid(nonempty(value.title), `${path}.title`);
}

function canonicalIssueUrl(repository, number) {
  return `https://github.com/${repository}/issues/${number}`;
}

function managedIssueText(number) {
  return `JV-${String(number).padStart(3, '0')} · ${canonicalIssueUrl(CONFIG.repository, number)}`;
}

function isManagedIssueText(value) {
  if (typeof value !== 'string') return false;
  const match = /^JV-\d{3,} · https:\/\/github\.com\/grasdouble\/Jarvis\/issues\/([1-9]\d*)$/.exec(value);
  if (!match) return false;
  const number = Number(match[1]);
  return positiveInteger(number) && value === managedIssueText(number);
}

function validateSnapshot(snapshot) {
  requireValid(record(snapshot), 'snapshot');
  requireValid(snapshot.projectId === CONFIG.projectId, 'snapshot.projectId scope');
  requireValid(snapshot.fieldId === CONFIG.fieldId, 'snapshot.fieldId scope');
  requireValid(Array.isArray(snapshot.pullRequests), 'snapshot.pullRequests');
  const ids = new Set();
  const numbers = new Set();
  const itemIds = new Set();
  for (const pr of snapshot.pullRequests) {
    requireValid(record(pr), 'pull request');
    requireValid(nonempty(pr.id), 'pull request.id');
    requireValid(positiveInteger(pr.number), 'pull request.number');
    requireValid(pr.repository === CONFIG.repository, 'pull request.repository scope');
    requireValid(pr.projectItemId === null || nonempty(pr.projectItemId), 'pull request.projectItemId');
    requireValid(pr.issueText === null || typeof pr.issueText === 'string', 'pull request.issueText');
    requireValid(Array.isArray(pr.labels) && Array.from(pr.labels).every(label => typeof label === 'string'), 'pull request.labels');
    requireValid(Array.isArray(pr.issues), 'pull request.issues');
    validateMilestone(pr.milestone, 'pull request.milestone');
    if (ids.has(pr.id) || numbers.has(pr.number) || (pr.projectItemId !== null && itemIds.has(pr.projectItemId))) {
      throw new TypeError('Duplicate pull request number, ID or project item ID.');
    }
    ids.add(pr.id);
    numbers.add(pr.number);
    if (pr.projectItemId !== null) itemIds.add(pr.projectItemId);
    for (const issue of pr.issues) {
      requireValid(record(issue), 'native issue');
      requireValid(positiveInteger(issue.number), 'native issue.number');
      requireValid(repositoryName(issue.repository), 'native issue.repository');
      requireValid(issue.url === canonicalIssueUrl(issue.repository, issue.number), 'native issue canonical URL');
      validateMilestone(issue.milestone, 'native issue.milestone');
    }
  }
}

/** Plan only derived project Issue text, membership, and native PR milestones. */
export function planMetadata(snapshot) {
  // Validate the whole scope before producing even a partial destination plan.
  validateSnapshot(snapshot);
  const updates = [];
  const diagnostics = [];
  const diagnostic = (number, code, severity) => diagnostics.push({ number, code, severity });
  for (const pr of snapshot.pullRequests) {
    if (pr.labels.includes('self-update')) {
      diagnostic(pr.number, 'self_update_exempt', 'notice');
      continue;
    }
    if (pr.issues.length === 0) {
      diagnostic(pr.number, 'missing_issue', 'notice');
      if (pr.projectItemId !== null && pr.issueText !== null) {
        if (isManagedIssueText(pr.issueText)) {
          updates.push({ number: pr.number, id: pr.id, itemId: pr.projectItemId, addToProject: false,
            issue: { before: pr.issueText, after: null }, milestone: null, source: null });
        } else {
          diagnostic(pr.number, 'manual_issue_text', 'error');
        }
      }
      continue;
    }
    if (pr.issues.length !== 1) {
      diagnostic(pr.number, 'ambiguous_issues', 'error');
      continue;
    }
    const sourceIssue = pr.issues[0];
    if (sourceIssue.repository !== CONFIG.repository) {
      diagnostic(pr.number, 'foreign_issue', 'error');
      continue;
    }
    if (sourceIssue.milestone === null) {
      diagnostic(pr.number, 'missing_milestone', 'error');
      continue;
    }
    const addToProject = pr.projectItemId === null;
    const beforeText = addToProject ? null : pr.issueText;
    const afterText = managedIssueText(sourceIssue.number);
    const beforeMilestone = pr.milestone?.number ?? null;
    const afterMilestone = sourceIssue.milestone.number;
    const issue = beforeText === afterText ? null : { before: beforeText, after: afterText };
    const milestone = beforeMilestone === afterMilestone ? null : { before: beforeMilestone, after: afterMilestone };
    if (addToProject || issue !== null || milestone !== null) {
      updates.push({ number: pr.number, id: pr.id, itemId: pr.projectItemId, addToProject, issue, milestone,
        source: { issueNumber: sourceIssue.number, issueUrl: sourceIssue.url,
          milestoneId: sourceIssue.milestone.id, milestoneNumber: afterMilestone } });
    }
  }
  return { updates, diagnostics };
}
