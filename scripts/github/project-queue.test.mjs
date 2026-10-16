import test from 'node:test';
import assert from 'node:assert/strict';
import { planQueue } from './project-queue.mjs';
const issue = (number, extra = {}) => ({ id: String(number), number, title: `Issue ${number}`, url: `https://github.com/grasdouble/Jarvis/issues/${number}`, state: 'OPEN', stateReason: null, createdAt: `2026-01-${String(number).padStart(2,'0')}T00:00:00Z`, milestone: 'J1 — Foundation', labels: ['priority:P1'], blockers: [], children: [], status: 'Backlog', ...extra });
const numbers = rows => rows.map(x => x.number);
test('dependencies outrank milestone and priority', () => {
  assert.deepEqual(numbers(planQueue([issue(1,{milestone:'J0',labels:['priority:P0'],blockers:['2']}),issue(2,{milestone:'J5'})])),[2,1]);
});
test('available work sorts by milestone, priority, creation time and number', () => {
  const inputs=[issue(4),issue(3,{labels:['priority:P0']}),issue(2,{milestone:'J0'}),issue(1)];
  assert.deepEqual(numbers(planQueue(inputs)),[2,3,1,4]);
  assert.deepEqual(planQueue(inputs),planQueue([...inputs].reverse()));
});
test('parents are coordination nodes and dependent work follows their children', () => {
  const rows=planQueue([issue(1,{children:['3']}),issue(2,{blockers:['1']}),issue(3)]);
  assert.deepEqual(numbers(rows),[3,2]);
  assert.deepEqual(rows[1].unmet,[1]);
});
test('only completed prerequisites can make Ready work a candidate', () => {
  const done=issue(1,{state:'CLOSED',stateReason:'COMPLETED'});
  assert.equal(planQueue([done,issue(2,{status:'Ready',blockers:['1']})])[0].candidate,true);
  const abandoned={...done,stateReason:'NOT_PLANNED'};
  assert.equal(planQueue([abandoned,issue(2,{status:'Ready',blockers:['1']})])[0].candidate,false);
});
test('active, review, blocked and Backlog work are never Ready candidates', () => {
  for (const status of ['In Progress','In Review','Blocked','Backlog']) assert.equal(planQueue([issue(1,{status})])[0].candidate,false);
});
test('cycles and missing dependency data stop planning', () => {
  assert.throws(()=>planQueue([issue(1,{blockers:['2']}),issue(2,{blockers:['1']})]),/cycle/i);
  assert.throws(()=>planQueue([issue(1,{blockers:['99']})]),/missing/i);
});
test('completed issues are omitted and remaining ranks are contiguous', () => {
  const rows=planQueue([issue(1,{state:'CLOSED',stateReason:'COMPLETED'}),issue(2),issue(3)]);
  assert.deepEqual(rows.map(x=>x.rank),[1,2]);
});

test('later numeric delivery phases precede named milestones regardless of age or priority', () => {
  const rows=planQueue([
    issue(1,{milestone:'Later',labels:['priority:P0']}),
    issue(2,{milestone:'J10 — Later work'}),
    issue(3,{milestone:'J7 — Self-improvement'}),
    issue(4,{milestone:'J6 — Autonomous delivery'}),
    issue(5,{milestone:'J100 — Distant work'}),
  ]);
  assert.deepEqual(numbers(rows),[4,3,2,5,1]);
});
test('dependencies still precede a lower phase number', () => {
  assert.deepEqual(numbers(planQueue([issue(1,{milestone:'J6',blockers:['2']}),issue(2,{milestone:'J7'})])),[2,1]);
});
test('all open leaves and coordination parents require a nonblank native milestone', () => {
  for (const milestone of [undefined,null,'','  ']) {
    assert.throws(()=>planQueue([issue(1,{milestone})]),/milestone/i);
    assert.throws(()=>planQueue([issue(1,{milestone,children:['2']}),issue(2)]),/milestone/i);
  }
});
test('completed historical issues without a milestone remain omitted from the implementation queue', () => {
  assert.deepEqual(numbers(planQueue([issue(1,{state:'CLOSED',stateReason:'COMPLETED',milestone:null}),issue(2)])),[2]);
});
test('only a whole nonnegative safe integer J phase is treated as numeric', () => {
  assert.deepEqual(numbers(planQueue([
    issue(1,{milestone:'J1.5 — Named'}),
    issue(2,{milestone:'J01 — Named'}),
    issue(3,{milestone:'J99999999999999999999 — Named'}),
    issue(4,{milestone:'J100'}),
  ])),[4,1,2,3]);
});
