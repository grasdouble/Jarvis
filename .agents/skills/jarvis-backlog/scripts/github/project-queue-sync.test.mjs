import { appNetworkError } from './gh-app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeQueue, queueRequestError } from './project-queue-sync.mjs';
import { refreshAfterQueue } from './queue-refresh-finalize.mjs';

test('best-effort main refresh failure cannot turn a successful queue write into failure', async () => {
  let queueSucceeded = false;
  const result = await synchronizeQueue({...fixture(), write:true});
  queueSucceeded = result.mode === 'updated' || result.mode === 'unchanged';
  const output = await refreshAfterQueue(result, async()=>{throw new Error('synthetic refresh failure');});
  assert.equal(queueSucceeded, true);
  assert.match(output, /mainRefresh.*skipped/);
});

test('main refresh runs after updated or unchanged queue success, but not after queue failure', async () => {
  for (const mode of ['updated', 'unchanged']) {
    let calls=0;
    const result=await refreshAfterQueue({mode},async()=>{calls++;return 'refreshed';});
    assert.equal(result,'refreshed'); assert.equal(calls,1);
  }
  let calls=0;
  assert.equal(await refreshAfterQueue({mode:'failed'},async()=>{calls++;}),null);
  assert.equal(calls,0);
});

function fixture(count = 12) {
  const state = { projectId:'project', fieldId:'rank', issues:[], items:[] };
  for (let number=1; number<=count; number++) {
    state.issues.push({ id:String(number), number, title:`Issue ${number}`, url:`https://example.test/${number}`,
      state:'OPEN', stateReason:null, createdAt:'2026-01-01T00:00:00Z', milestone:'J00',
      labels:['priority:P1'], blockers:[], children:[], status:'Backlog' });
    state.items.push({ id:`item${number}`, content:{id:String(number)}, fieldValues:{
      pageInfo:{hasNextPage:false}, nodes:[] } });
  }
  const writes = [], waits = [];
  const apply = batch => batch.forEach(change => {
    const item = state.items.find(x=>x.id === change.itemId);
    item.fieldValues.nodes = change.rank === undefined ? [] : [{number:change.rank, field:{id:'rank',name:'Execution order'}}];
  });
  return { state, writes, waits, apply, load:async()=>structuredClone(state),
    wait:async ms=>waits.push(ms), writeBatch:async(_,batch)=>{writes.push(structuredClone(batch));apply(batch);} };
}
const timeout = () => Object.assign(new Error('GitHub request timed out'), {retryable:true});

test('a timeout after partial success resumes only missing ranks in small sequential batches', async () => {
  const f = fixture();
  let first = true;
  const result = await synchronizeQueue({...f, write:true, writeBatch:async(_,batch)=>{
    f.writes.push(structuredClone(batch));
    if (first) { first=false;f.apply(batch.slice(0,3));throw timeout(); }
    f.apply(batch);
  }});
  assert.equal(result.mode,'updated');
  assert.equal(result.changes,12);
  assert.ok(f.writes.every(batch=>batch.length<=5));
  assert.ok(f.writes.slice(1).flat().every(x=>!['item1','item2','item3'].includes(x.itemId)));
  assert.deepEqual(f.state.items.map(x=>x.fieldValues.nodes[0].number),Array.from({length:12},(_,i)=>i+1));
});

test('successful writes use batches of five and pause between requests', async () => {
  const f=fixture();
  assert.equal((await synchronizeQueue({...f,write:true})).changes,12);
  assert.deepEqual(f.writes.map(x=>x.length),[5,5,2]);
  assert.deepEqual(f.waits,[1000,1000]);
});

test('preview and an already synchronized write never mutate or wait', async () => {
  const f=fixture(3);
  assert.equal((await synchronizeQueue(f)).mode,'preview');
  assert.equal(f.writes.length,0);
  await synchronizeQueue({...f,write:true});
  f.writes.length=0;f.waits.length=0;
  assert.equal((await synchronizeQueue({...f,write:true})).mode,'unchanged');
  assert.deepEqual(f.writes,[]);assert.deepEqual(f.waits,[]);
});

for (const applied of [0,5]) test(`a lost response with ${applied} applied writes reconciles before retry`, async () => {
  const f=fixture(7);
  let first=true;
  await synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(structuredClone(batch));
    if (first) { first=false;f.apply(batch.slice(0,applied));throw timeout(); }
    f.apply(batch);
  }});
  assert.equal(f.writes.slice(1).flat().filter(x=>x.itemId==='item1').length,applied ? 0 : 1);
  assert.equal(f.state.items[6].fieldValues.nodes[0].number,7);
});

test('a timeout after the entire desired state was applied needs no second mutation', async () => {
  const f=fixture(3);
  const result=await synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.apply(batch);throw timeout();
  }});
  assert.equal(result.mode,'updated');assert.equal(f.writes.length,1);
});

test('reconciliation includes cleared ranks of closed issues', async () => {
  const f=fixture(3);
  f.state.issues[0].state='CLOSED';f.state.issues[0].stateReason='COMPLETED';
  f.apply([{itemId:'item1',rank:1}]);
  let first=true;
  await synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(structuredClone(batch));
    if(first){first=false;f.apply(batch.slice(0,1));throw timeout();}
    f.apply(batch);
  }});
  assert.deepEqual(f.state.items[0].fieldValues.nodes,[]);
  assert.ok(f.writes.slice(1).flat().every(x=>x.itemId!=='item1'));
  assert.deepEqual(f.state.items.slice(1).map(x=>x.fieldValues.nodes[0].number),[1,2]);
});

test('repeated transient failures stop after three recovery rounds', async () => {
  const f=fixture(3);
  await assert.rejects(synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);throw timeout();
  }}),/budget exhausted/);
  assert.equal(f.writes.length,4);
  assert.ok(f.waits.every(ms=>ms<=8000));
});

test('permanent failures reread partial progress but never retry', async () => {
  const f=fixture(3);let reads=0;
  await assert.rejects(synchronizeQueue({...f,write:true,load:async()=>{reads++;return f.load();},writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.apply(batch.slice(0,1));throw new Error('Forbidden');
  }}),/Non-retryable/);
  assert.equal(reads,3);assert.equal(f.writes.length,1);
  assert.equal(f.state.items[0].fieldValues.nodes[0].number,1);
});

test('an unreadable reconciliation snapshot stops further writes', async () => {
  const f=fixture(3);let reads=0;
  await assert.rejects(synchronizeQueue({...f,write:true,load:async()=>{
    if(++reads===3) throw new Error('Read unavailable');return f.load();
  },writeBatch:async(_,batch)=>{f.writes.push(batch);throw timeout();}}),/Read unavailable/);
  assert.equal(f.writes.length,1);
});

for (const mutate of [
  f=>{f.state.issues[0].status='Ready';},
  f=>{f.state.issues[0].blockers=['2'];},
  f=>{f.state.issues[0].labels=['priority:P0'];},
  f=>{f.state.items.pop();},
  f=>{f.state.projectId='other';},
]) test('changed planning inputs or membership prevent recovery writes', async () => {
  const f=fixture(7);
  await assert.rejects(synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.apply(batch.slice(0,1));mutate(f);throw timeout();
  }}),/planning inputs changed/);
  assert.equal(f.writes.length,1);
});

for (const itemId of ['item1','item7']) test(`an unexpected rank edit to ${itemId} stops recovery`, async () => {
  const f=fixture(7);
  await assert.rejects(synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.apply([{itemId,rank:99}]);throw timeout();
  }}),/Unexpected rank edit/);
  assert.equal(f.writes.length,1);
});

test('a changed snapshot before the first mutation prevents every write', async () => {
  const f=fixture(3);let reads=0;
  await assert.rejects(synchronizeQueue({...f,write:true,load:async()=>{
    if(++reads===2) f.state.issues[0].title='Changed';return f.load();
  }}),/changed during planning/);
  assert.deepEqual(f.writes,[]);
});

test('successful responses still require verification and bounded repair of missing ranks', async () => {
  const f=fixture(3);let first=true;
  await synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);if(first){first=false;return;}f.apply(batch);
  }});
  assert.equal(f.state.items[2].fieldValues.nodes[0].number,3);
  const broken=fixture(3);
  await assert.rejects(synchronizeQueue({...broken,write:true,writeBatch:async(_,batch)=>{
    broken.writes.push(batch);
  }}),/budget exhausted/);
});

test('only recognized transient transport/GraphQL failures are retryable and diagnostics are sanitized', () => {
  for(const stderr of ['gh: server failed (HTTP 502)','HTTP 504','HTTP 503','read: ECONNRESET','context deadline exceeded'])
    assert.equal(queueRequestError({stderr}).retryable,true,stderr);
  for(const stderr of ['HTTP 401','HTTP 403','HTTP 429','validation failed','rate limit exceeded','HTTP 403 request timed out','HTTP 502 secondary rate limit','unknown'])
    assert.equal(queueRequestError({stderr}).retryable,false,stderr);
  assert.equal(queueRequestError({stdout:JSON.stringify({errors:[{message:"We couldn't respond to your request in time"}]})}).retryable,true);
  assert.equal(queueRequestError({stdout:JSON.stringify({errors:[{message:'request timed out'},{message:'Forbidden'}]})}).retryable,false);
  const result=queueRequestError({stderr:'private diagnostic HTTP 502'});
  assert.ok(!result.message.includes('private diagnostic'));
});

test('adding a rank may change the field connection cursor without changing planning inputs', async () => {
  const f=fixture(3);
  for(const item of f.state.items) item.fieldValues.pageInfo.endCursor='before';
  await synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.apply(batch);
    for(const item of f.state.items) item.fieldValues.pageInfo.endCursor='after';
  }});
  assert.equal(f.state.items[2].fieldValues.nodes[0].number,3);
});

test('verification rejects planning changes even when every rank is correct', async () => {
  const f=fixture(3);
  await assert.rejects(synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.apply(batch);f.state.issues[0].status='Ready';
  }}),/planning inputs changed/);
  assert.equal(f.writes.length,1);
});

test('truncated reconciliation fields stop further writes', async () => {
  const f=fixture(3);
  await assert.rejects(synchronizeQueue({...f,write:true,writeBatch:async(_,batch)=>{
    f.writes.push(batch);f.state.items[0].fieldValues.pageInfo.hasNextPage=true;throw timeout();
  }}),/Incomplete item fields/);
  assert.equal(f.writes.length,1);
});

test('a missing milestone aborts before any rank write, including for a coordination parent', async () => {
  const f=fixture(3);
  f.state.issues[0].milestone=null;
  f.state.issues[0].children=['2'];
  await assert.rejects(synchronizeQueue({...f,write:true}),/milestone/i);
  assert.deepEqual(f.writes,[]);
});


test('App network failures retain safe recovery guidance without automatic retries', () => {
  const result = queueRequestError({status:75, stderr:'JARVIS_GITHUB_NETWORK: EAI_AGAIN synthetic-secret'});
  assert.equal(result.networkFailure, true);
  assert.equal(result.retryable, false);
  assert.match(result.message, /JARVIS_GITHUB_NETWORK:/);
  assert.match(result.message, /--check-network/);
  assert.ok(!result.message.includes('synthetic-secret'));
  assert.notEqual(queueRequestError({status:1, stderr:'HTTP 403 JARVIS_GITHUB_NETWORK:'}).networkFailure, true);
});

for (const applied of [0, 1, 3]) test(`network queue failure retains recovery after rereading ${applied} applied ranks`, async () => {
  const f=fixture(3); let reads=0;
  const failure=appNetworkError({status:75,stderr:'JARVIS_GITHUB_NETWORK: EAI_AGAIN private-cause'});
  await assert.rejects(synchronizeQueue({...f,write:true,
    load:async()=>{reads++;return f.load();},
    writeBatch:async(_,batch)=>{f.writes.push(batch);f.apply(batch.slice(0,applied));throw failure;},
  }),error=>{
    assert.equal(error.networkFailure,true);assert.equal(error.exitCode,75);
    assert.match(error.message,/JARVIS_GITHUB_NETWORK:/);assert.doesNotMatch(error.message,/private-cause/);
    return true;
  });
  assert.equal(reads,3,'remote state must be reread before surfacing failure');
  assert.equal(f.writes.length,1,'never replay network-interrupted writes automatically');
  assert.equal(f.state.items.filter(i=>i.fieldValues.nodes.length).length,applied);
});
