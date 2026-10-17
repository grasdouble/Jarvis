import test from 'node:test';
import assert from 'node:assert/strict';
import { planDates, sourceKey, ROADMAP_CONFIG as config } from './roadmap-dates.mjs';

const progress = (createdAt = '2026-01-15T10:00:00Z', extra = {}) => ({
  __typename: 'ProjectV2ItemStatusChangedEvent', createdAt,
  previousStatus: 'Ready', status: 'In Progress', project: { id: config.projectId }, wasAutomated: false, ...extra,
});
const closed = (createdAt = '2026-01-16T10:00:00Z', closer = null) => ({ __typename: 'ClosedEvent', createdAt, closer });
const reopened = (createdAt = '2026-01-17T10:00:00Z') => ({ __typename: 'ReopenedEvent', createdAt });
const issue = (extra = {}) => ({ id: 'I_1', number: 1, repository: config.repository, itemId: 'PVTI_1',
  status: 'In Progress', state: 'OPEN', stateReason: null, closedAt: null,
  actualStart: null, actualCompletion: null, history: [], ...extra });
const done = (extra = {}) => issue({ status: 'Done', state: 'CLOSED', stateReason: 'COMPLETED',
  closedAt: '2026-01-16T10:00:00Z', history: [progress(), closed()], ...extra });
const snapshot = (...issues) => ({ projectId: config.projectId, startFieldId: config.startFieldId,
  completionFieldId: config.completionFieldId, issues });
const update = (fields, extra = {}) => ({ number: 1, id: 'I_1', itemId: 'PVTI_1', fields, ...extra });
const change = (after, before = null) => ({ before, after });
const fields = input => planDates(snapshot(input)).updates[0]?.fields;

test('first recorded project In Progress transition is the actual start', () => {
  assert.deepEqual(planDates(snapshot(issue({ history: [progress('2026-02-01T10:00:00Z'), progress()] }))), {
    updates: [update({ start: change('2026-01-15') })], diagnostics: [],
  });
});

test('dates use Paris midnight and seasonal offsets, including DST boundaries', () => {
  for (const [instant, day] of [
    ['2026-01-15T23:30:00Z', '2026-01-16'], ['2026-06-15T22:30:00Z', '2026-06-16'],
    ['2026-03-29T00:59:59Z', '2026-03-29'], ['2026-03-29T01:00:00Z', '2026-03-29'],
    ['2026-10-25T00:59:59Z', '2026-10-25'], ['2026-10-25T01:00:00Z', '2026-10-25'],
    ['2026-01-16T00:15:00+02:00', '2026-01-15'],
  ]) assert.deepEqual(fields(issue({ history: [progress(instant)] })), { start: change(day) });
});

test('merge completion uses mergedAt and tolerates native closure event lag', () => {
  const input = done({ closedAt: '2026-01-16T23:00:00Z', history: [progress(),
    closed('2026-01-16T23:00:01Z', { __typename: 'PullRequest', number: 5, mergedAt: '2026-01-16T22:59:59Z' })] });
  assert.deepEqual(fields(input), { start: change('2026-01-15'), completion: change('2026-01-16') });
});

test('manual and Commit closers use native closedAt', () => {
  for (const closer of [null, { __typename: 'Commit' }]) {
    assert.deepEqual(fields(done({ history: [progress(), closed(undefined, closer)] })), {
      start: change('2026-01-15'), completion: change('2026-01-16'),
    });
  }
});

test('only project transitions prove start; post-closure transitions are ignored', () => {
  const input = done({ history: [progress('2026-01-14T10:00:00Z', { project: { id: 'OTHER' } }), closed(),
    progress('2026-01-16T10:00:01Z')] });
  assert.deepEqual(planDates(snapshot(input)), { updates: [update({ completion: change('2026-01-16') })],
    diagnostics: [{ number: 1, code: 'unknown_start', severity: 'notice' }] });
  assert.equal(fields(issue({ history: [progress(undefined, { status: 'In Review' })] })), undefined);
});

test('unknown start is never guessed from closure, old fields or creation metadata', () => {
  const input = done({ createdAt: '2026-01-01T00:00:00Z', actualStart: '2026-01-01', history: [closed()] });
  assert.deepEqual(fields(input), { start: change(null, '2026-01-01'), completion: change('2026-01-16') });
  for (const status of ['In Progress', 'In Review', 'Blocked', 'Done']) {
    assert.deepEqual(planDates(snapshot(issue({ status }))).diagnostics, [{ number: 1, code: 'unknown_start', severity: 'notice' }]);
  }
  for (const status of ['Backlog', 'Ready', null]) assert.deepEqual(planDates(snapshot(issue({ status }))).diagnostics, []);
  assert.equal(planDates(snapshot(done({ stateReason: 'NOT_PLANNED', history: [closed()] }))).diagnostics[0].code, 'unknown_start');
});

test('reopens preserve earliest historical start and clear stale completion', () => {
  const input = issue({ stateReason: 'REOPENED', actualStart: '2026-01-15', actualCompletion: '2026-01-16',
    history: [progress('2026-01-18T10:00:00Z'), reopened(), closed(), progress()] });
  assert.deepEqual(fields(input), { completion: change(null, '2026-01-16') });
  const reclosed = done({ closedAt: '2026-01-20T10:00:00Z', history: [...input.history, closed('2026-01-20T10:00:00Z')] });
  assert.deepEqual(fields(reclosed), { start: change('2026-01-15'), completion: change('2026-01-20') });
});

test('open, not-planned and incomplete project state never retain completion', () => {
  for (const input of [issue(), done({ stateReason: 'NOT_PLANNED' }), done({ stateReason: null }), done({ status: 'In Review' })]) {
    assert.deepEqual(fields({ ...input, actualCompletion: '2026-01-01' })?.completion, change(null, '2026-01-01'));
  }
});

test('current completion requires the last native close to match, within five seconds', () => {
  for (const history of [[], [closed('2026-01-01T00:00:00Z')],
    [closed(), closed('2026-01-16T10:00:06Z')]]) {
    const result = planDates(snapshot(done({ actualStart: '2026-01-01', history })));
    assert.deepEqual(result.updates, []);
    assert.ok(result.diagnostics.some(d => d.code === 'missing_matching_closure' && d.severity === 'error'));
  }
  assert.ok(fields(done({ history: [progress(), closed('2026-01-16T10:00:05Z')] })).completion);
});

test('unmerged or future closing PRs skip the entire issue', () => {
  for (const [mergedAt, code] of [[null, 'unmerged_closing_pr'], ['2026-01-16T10:00:06Z', 'invalid_closing_pr_time']]) {
    assert.deepEqual(planDates(snapshot(done({ history: [progress(), closed(undefined,
      { __typename: 'PullRequest', number: 2, mergedAt })] }))), {
      updates: [], diagnostics: [{ number: 1, code, severity: 'error' }],
    });
  }
});

test('a start after the merged completion instant skips all issue writes', () => {
  assert.deepEqual(planDates(snapshot(done({ history: [progress('2026-01-16T09:59:59Z'),
    closed(undefined, { __typename: 'PullRequest', number: 2, mergedAt: '2026-01-16T09:59:58Z' })] }))), {
    updates: [], diagnostics: [{ number: 1, code: 'start_after_completion', severity: 'error' }],
  });
});

test('complete snapshot validation rejects malformed values before returning any plans', () => {
  const malformed = [
    { id: '' }, { itemId: null }, { number: 0 }, { number: Number.MAX_SAFE_INTEGER + 1 }, { repository: 'other/Repo' },
    { status: '' }, { state: 'UNKNOWN' }, { stateReason: 'UNKNOWN' }, { closedAt: 'yesterday' },
    { closedAt: '2026-02-30T00:00:00Z' }, { actualStart: '2026-02-30' }, { actualCompletion: '2026-1-01' },
    { history: null }, { history: [{ __typename: 'UnknownEvent', createdAt: '2026-01-01T00:00:00Z' }] },
    { history: [progress('2026-01-01T24:00:00Z')] }, { history: [progress('2026-01-01T00:00:00')] },
    { history: [progress(undefined, { project: null })] }, { history: [progress(undefined, { wasAutomated: 'false' })] },
    { history: [progress(undefined, { status: {} })] }, { history: [closed(undefined, {})] },
    { history: [closed(undefined, { __typename: 'PullRequest', number: 0, mergedAt: null })] },
    { history: [closed(undefined, { __typename: 'PullRequest', number: 1, mergedAt: '2026-13-01T00:00:00Z' })] },
    { history: [reopened('2026-04-31T00:00:00Z')] },
  ];
  for (const extra of malformed) assert.throws(() => planDates(snapshot(issue({ history: [progress()] }), issue({ id: 'I_2', itemId: 'PVTI_2', number: 2, ...extra }))));
  for (const key of ['projectId', 'startFieldId', 'completionFieldId']) assert.throws(() => planDates({ ...snapshot(), [key]: 'other' }));
  for (const input of [null, {}, { ...snapshot(), issues: {} }]) assert.throws(() => planDates(input));
});

test('duplicate issue numbers, node IDs and project item IDs reject the entire snapshot', () => {
  for (const extra of [{ number: 1 }, { id: 'I_1' }, { itemId: 'PVTI_1' }]) {
    assert.throws(() => planDates(snapshot(issue(), issue({ id: 'I_2', number: 2, itemId: 'PVTI_2', ...extra }))));
  }
});

test('planning is immutable and applying the plan is idempotent', () => {
  const input = snapshot(done());
  const original = structuredClone(input);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(input);
  const result = planDates(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(planDates(snapshot(done({ actualStart: '2026-01-15', actualCompletion: '2026-01-16' }))), { updates: [], diagnostics: [] });
  assert.ok(Object.isFrozen(config));
});

test('source fingerprint binds every native source but excludes both destination fields', () => {
  const input = done();
  const key = sourceKey(input);
  assert.equal(key, sourceKey(structuredClone(input)));
  assert.equal(key, sourceKey({ ...input, actualStart: '2026-01-15', actualCompletion: '2026-01-16' }));
  for (const extra of [{ itemId: 'PVTI_other' }, { status: 'Ready' }, { stateReason: 'NOT_PLANNED' },
    { closedAt: '2026-01-17T00:00:00Z' }, { history: [progress(), closed(), reopened()] }]) {
    assert.notEqual(key, sourceKey({ ...input, ...extra }));
  }
});

test('native initial project transitions may have an empty previous status',()=>{
 const snapshot={projectId:config.projectId,startFieldId:config.startFieldId,completionFieldId:config.completionFieldId,issues:[{id:'I_native',number:93,repository:config.repository,itemId:'ITEM_native',status:'Backlog',state:'OPEN',stateReason:null,closedAt:null,actualStart:null,actualCompletion:null,history:[{__typename:'ProjectV2ItemStatusChangedEvent',createdAt:'2026-10-17T09:00:00Z',previousStatus:'',status:'Backlog',project:{id:config.projectId},wasAutomated:false}]}]};
 assert.doesNotThrow(()=>planDates(snapshot));assert.equal(planDates(snapshot).updates.length,0);
});
