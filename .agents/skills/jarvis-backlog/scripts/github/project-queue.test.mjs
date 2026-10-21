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
test('a child uses its coordination parent milestone context before its own milestone', () => {
  const child=issue(34,{milestone:'DEV — Tooling & validation',labels:['priority:P1']});
  const parent=issue(32,{milestone:'J01 — Isolation',labels:['priority:P1'],children:['34']});
  const sameParentPhase=issue(35,{milestone:'J01 — Isolation',labels:['priority:P1']});
  const laterPhase=issue(8,{milestone:'J02 — Project foundation',labels:['priority:P0']});

  const rows=planQueue([child,parent,laterPhase,sameParentPhase]);
  assert.deepEqual(numbers(rows),[35,34,8]);
  assert.equal(rows.some(row=>row.number===32),false);
  assert.equal(child.milestone,'DEV — Tooling & validation');
  assert.deepEqual(child.labels,['priority:P1']);
});
test('a child uses its coordination parent priority before its own priority', () => {
  const child=issue(34,{milestone:'DEV — Tooling & validation',labels:['priority:P2']});
  const parent=issue(32,{milestone:'J01 — Isolation',labels:['priority:P0'],children:['34']});
  const samePhaseLowerPriority=issue(35,{milestone:'J01 — Isolation',labels:['priority:P1']});

  assert.deepEqual(numbers(planQueue([samePhaseLowerPriority,child,parent])),[34,35]);
});
test('children use their own milestone and priority as tie-breakers within parent context', () => {
  const parent=issue(32,{milestone:'J01 — Isolation',labels:['priority:P1'],children:['34','35']});
  const laterOwnPhase=issue(34,{milestone:'J02 — Project foundation',labels:['priority:P0']});
  const earlierOwnPhase=issue(35,{milestone:'DEV — Tooling & validation',labels:['priority:P2']});

  assert.deepEqual(numbers(planQueue([earlierOwnPhase,parent,laterOwnPhase])),[34,35]);
});
test('children use their own priority when parent context and own phase are tied', () => {
  const parent=issue(32,{milestone:'J01 — Isolation',labels:['priority:P1'],children:['34','35']});
  const lowerOwnPriority=issue(34,{milestone:'DEV — Tooling & validation',labels:['priority:P2']});
  const higherOwnPriority=issue(35,{milestone:'DEV — Tooling & validation',labels:['priority:P0']});

  assert.deepEqual(numbers(planQueue([lowerOwnPriority,parent,higherOwnPriority])),[35,34]);
});
test('blocking dependencies remain ahead of a child parent-context sort key', () => {
  const child=issue(1,{milestone:'J01 — Isolation',blockers:['3']});
  const parent=issue(32,{milestone:'J00 — Scoping',children:['1']});
  const laterPhaseBlocker=issue(3,{milestone:'J02 — Project foundation'});

  assert.deepEqual(numbers(planQueue([child,parent,laterPhaseBlocker])),[3,1]);
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
    issue(2,{milestone:'J001 — Named'}),
    issue(3,{milestone:'J99999999999999999999 — Named'}),
    issue(4,{milestone:'J100'}),
  ])),[4,1,2,3]);
});

test('padded product phases sort numerically through J10 before named outcomes', () => {
  assert.deepEqual(numbers(planQueue([
    issue(1,{milestone:'J01 — Foundation'}),
    issue(2,{milestone:'J10 — Forecasting'}),
    issue(3,{milestone:'J02 — Observation'}),
    issue(4,{milestone:'J00 — Scoping'}),
    issue(5,{milestone:'J09 — Messaging'}),
    issue(6,{milestone:'DEV — Tooling',labels:['priority:P0']}),
  ])),[4,1,3,5,2,6]);
});

test('renaming legacy phases preserves ranks, dependencies and Ready eligibility', () => {
  const legacy=[
    issue(1,{milestone:'J0',status:'Ready',blockers:['3']}),
    issue(2,{milestone:'J1',status:'Ready'}),
    issue(3,{milestone:'J9',status:'Ready'}),
    issue(4,{milestone:'J10',status:'Ready'}),
    issue(5,{milestone:'DEV — Tooling'}),
    issue(6,{milestone:'J7',children:['7']}),
    issue(7,{milestone:'J7'}),
    issue(8,{milestone:'J6',state:'CLOSED',stateReason:'NOT_PLANNED'}),
    issue(9,{milestone:'J2',status:'Ready',blockers:['8']}),
  ];
  const padded=legacy.map(row=>({...row,milestone:row.milestone.replace(/^J(\d)$/, 'J0$1')}));
  const mixed=padded.map((row,index)=>index%2?row:legacy[index]);
  const expected=planQueue(legacy);
  assert.deepEqual(planQueue(padded),expected);
  assert.deepEqual(planQueue(mixed),expected);
  assert.deepEqual(expected.find(row=>row.number===9).unmet,[8]);
  assert.equal(expected.find(row=>row.number===9).candidate,false);
});
