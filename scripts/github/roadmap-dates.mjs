import { createHash } from 'node:crypto';

export const ROADMAP_CONFIG = Object.freeze({
  repository: 'grasdouble/Jarvis',
  projectId: 'PVT_kwDOAvfTzc4BnQz1',
  startFieldId: 'PVTF_lADOAvfTzc4BnQz1zhmCUrk',
  completionFieldId: 'PVTF_lADOAvfTzc4BnQz1zhmCUr0',
  startFieldName: 'Actual start',
  completionFieldName: 'Actual completion',
  timeZone: 'Europe/Paris',
});

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ROADMAP_CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nullableText = value => value === null || nonempty(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const fail = label => { throw new Error(`Invalid roadmap snapshot: ${label}.`); };

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function instant(value, label) {
  // Date.parse normalizes impossible days; validate the source calendar separately.
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  const milliseconds = match && validCalendarDate(match[1]) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) fail(label);
  return milliseconds;
}

function validateEvent(event, label) {
  if (!record(event)) fail(label);
  instant(event.createdAt, `${label} createdAt`);
  switch (event.__typename) {
    case 'ProjectV2ItemStatusChangedEvent':
      if (!record(event.project) || !nonempty(event.project.id) || !(event.previousStatus === null || typeof event.previousStatus === 'string') ||
        !(event.status === null || typeof event.status === 'string') || typeof event.wasAutomated !== 'boolean') fail(`${label} project transition`);
      break;
    case 'ClosedEvent': {
      const closer = event.closer;
      if (closer === null) break;
      if (!record(closer)) fail(`${label} closer`);
      if (closer.__typename === 'PullRequest') {
        if (!positiveInteger(closer.number)) fail(`${label} closing PR number`);
        if (closer.mergedAt !== null) instant(closer.mergedAt, `${label} mergedAt`);
      } else if (closer.__typename !== 'Commit') fail(`${label} unknown closer`);
      break;
    }
    case 'ReopenedEvent':
      break;
    default:
      fail(`${label} unknown native event`);
  }
}

function validateSnapshot(snapshot) {
  if (!record(snapshot)) fail('snapshot object');
  for (const key of ['projectId', 'startFieldId', 'completionFieldId']) {
    if (snapshot[key] !== ROADMAP_CONFIG[key]) fail(`${key} scope`);
  }
  if (!Array.isArray(snapshot.issues)) fail('issues array');
  const unique = { id: new Set(), number: new Set(), itemId: new Set() };
  for (const issue of snapshot.issues) {
    if (!record(issue)) fail('issue object');
    const label = `issue #${issue.number}`;
    if (!nonempty(issue.id) || !nonempty(issue.itemId) || !positiveInteger(issue.number) ||
      issue.repository !== ROADMAP_CONFIG.repository || !nullableText(issue.status)) fail(`${label} identity/scope/status`);
    if (!['OPEN', 'CLOSED'].includes(issue.state) || ![null, 'COMPLETED', 'NOT_PLANNED', 'REOPENED'].includes(issue.stateReason)) fail(`${label} state`);
    if (issue.closedAt !== null) instant(issue.closedAt, `${label} closedAt`);
    if ((issue.state === 'CLOSED') !== (issue.closedAt !== null)) fail(`${label} inconsistent closure state`);
    for (const key of ['actualStart', 'actualCompletion']) {
      if (issue[key] !== null && !validCalendarDate(issue[key])) fail(`${label} ${key}`);
    }
    for (const key of Object.keys(unique)) {
      if (unique[key].has(issue[key])) fail(`duplicate ${key}`);
      unique[key].add(issue[key]);
    }
    if (!Array.isArray(issue.history)) fail(`${label} history array`);
    issue.history.forEach((event, index) => validateEvent(event, `${label} history[${index}]`));
  }
}

function calendarDate(milliseconds) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(milliseconds).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Derive only reserved actual date fields from a complete native GitHub snapshot. */
export function planDates(snapshot) {
  // Validate every issue before producing any plan, including issues without changes.
  validateSnapshot(snapshot);
  const updates = [];
  const diagnostics = [];
  for (const issue of snapshot.issues) {
    const diagnostic = (code, severity = 'error') => diagnostics.push({ number: issue.number, code, severity });
    const closedAt = issue.closedAt === null ? null : Date.parse(issue.closedAt);
    const history = [...issue.history].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const startEvent = history.find(event => event.__typename === 'ProjectV2ItemStatusChangedEvent' &&
      event.project.id === ROADMAP_CONFIG.projectId && event.status === 'In Progress' &&
      (closedAt === null || Date.parse(event.createdAt) <= closedAt));
    const start = startEvent ? Date.parse(startEvent.createdAt) : null;
    let completion = null;
    if (issue.state === 'CLOSED' && issue.stateReason === 'COMPLETED' && issue.status === 'Done') {
      const lastClose = history.filter(event => event.__typename === 'ClosedEvent').at(-1);
      if (!lastClose || Math.abs(Date.parse(lastClose.createdAt) - closedAt) > 5_000) {
        diagnostic('missing_matching_closure');
        continue;
      }
      if (lastClose.closer?.__typename === 'PullRequest') {
        if (lastClose.closer.mergedAt === null) {
          diagnostic('unmerged_closing_pr');
          continue;
        }
        completion = Date.parse(lastClose.closer.mergedAt);
        if (completion > closedAt + 5_000) {
          diagnostic('invalid_closing_pr_time');
          continue;
        }
      } else completion = closedAt;
      if (start !== null && start > completion) {
        diagnostic('start_after_completion');
        continue;
      }
    }
    if (start === null && (issue.state === 'CLOSED' || ['In Progress', 'In Review', 'Blocked', 'Done'].includes(issue.status))) {
      diagnostic('unknown_start', 'notice');
    }
    const fields = {};
    const addChange = (field, before, milliseconds) => {
      const after = milliseconds === null ? null : calendarDate(milliseconds);
      if (before !== after) fields[field] = { before, after };
    };
    addChange('start', issue.actualStart, start);
    addChange('completion', issue.actualCompletion, completion);
    if (Object.keys(fields).length) updates.push({ number: issue.number, id: issue.id, itemId: issue.itemId, fields });
  }
  return { updates, diagnostics };
}

/** Bind a write precondition to native sources, excluding the two derived destinations. */
export function sourceKey(issue) {
  const { actualStart, actualCompletion, ...source } = issue;
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
