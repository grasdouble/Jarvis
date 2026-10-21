import { appNetworkError } from './gh-app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeMetadata } from './pr-project-metadata-sync.mjs';

const projectId = 'PVT_kwDOAvfTzc4BnQz1';
const fieldId = 'PVTF_lADOAvfTzc4BnQz1zhl_aaw';
function fixture() {
  return {projectId, fieldId, pullRequests: [{id:'PR_test',number:92,repository:'grasdouble/Jarvis',projectItemId:null,issueText:null,milestone:null,labels:[],issues:[{number:91,url:'https://github.com/grasdouble/Jarvis/issues/91',repository:'grasdouble/Jarvis',milestone:{id:'M_test',number:1,title:'J00 — Scoping'}}]}]};
}
function harness() {
  const state=fixture(), effects=[];
  const load=async()=>structuredClone(state);
  const apply=async effect=>{
    effects.push(effect);
    const pr=state.pullRequests[0];
    if(effect.kind==='add')pr.projectItemId='ITEM_test';
    else if(effect.kind==='milestone')pr.milestone={id:'M_test',number:effect.milestoneNumber,title:'J00 — Scoping'};
    else if(effect.kind==='issue')pr.issueText=effect.text;
    else throw new Error('Forbidden effect');
  };
  return {state,effects,load,apply};
}
test('synchronizes the issue URL and native milestone, then repeats without writes',async()=>{
  const h=harness();
  const first=await synchronizeMetadata({...h,write:true});
  assert.deepEqual(h.effects.map(e=>e.kind),['add','milestone','issue']);
  assert.equal(first.pending,0);
  assert.equal(h.state.pullRequests[0].issueText,'JV-091 · https://github.com/grasdouble/Jarvis/issues/91');
  const count=h.effects.length;
  const second=await synchronizeMetadata({...h,write:true});
  assert.equal(second.mode,'unchanged');assert.equal(h.effects.length,count);
});
test('preview never invokes effects',async()=>{
  const h=harness();const r=await synchronizeMetadata({...h});
  assert.equal(r.mode,'preview');assert.equal(r.pending,1);assert.equal(h.effects.length,0);
});
test('preview identifies each PR and every observed-to-expected destination change',async()=>{
  const h=harness();const r=await synchronizeMetadata({...h});
  assert.deepEqual(r.pendingChanges,[{
    number:92,projectItemId:null,
    source:{issueNumber:91,issueUrl:'https://github.com/grasdouble/Jarvis/issues/91',milestoneId:'M_test',milestoneNumber:1},
    changes:{
      projectMembership:{before:false,after:true},
      milestone:{before:null,after:1},
      issue:{before:null,after:'JV-091 · https://github.com/grasdouble/Jarvis/issues/91'},
    },
  }]);
});
test('an applied ambiguous effect with stale immediate readback is not replayed and final verification can converge',async()=>{
  const h=harness();let writes=0,staleReads=1;
  const apply=async effect=>{
    writes++;await h.apply(effect);
    if(writes===1)throw Object.assign(new Error('ambiguous timeout'),{retryable:true,ambiguous:true});
  };
  const load=async()=>{
    if(writes===1&&staleReads-->0)return fixture();
    return h.load();
  };
  const result=await synchronizeMetadata({...h,load,apply,write:true,pause:async()=>{}});
  assert.equal(h.effects.filter(effect=>effect.kind==='add').length,1);
  assert.equal(result.mode,'synchronized');assert.equal(result.pending,0);
  assert.equal(result.attemptedWrites,3);assert.deepEqual(result.diagnostics,[]);
});
test('a persistent no-progress readback stops after one mutation and reports its exact delta',async()=>{
  const h=harness();
  const result=await synchronizeMetadata({...h,write:true,pause:async()=>{},apply:async effect=>{h.effects.push(effect);}});
  assert.equal(h.effects.length,1);assert.equal(result.mode,'incomplete');assert.equal(result.pending,1);
  assert.deepEqual(result.pendingChanges[0].changes.projectMembership,{before:false,after:true});
  assert.deepEqual(result.diagnostics,[{
    number:92,code:'no_progress',severity:'error',effect:'add',
    source:{issueNumber:91,issueUrl:'https://github.com/grasdouble/Jarvis/issues/91',milestoneId:'M_test',milestoneNumber:1},
    observed:{projectMembership:false},expected:{projectMembership:true},
    outcome:'no_error_response',
  }]);
});
test('a final planner error is not counted as a verified PR',async()=>{
  const h=harness();const pr=h.state.pullRequests[0];
  pr.issues=[];pr.projectItemId='ITEM_test';
  pr.issueText='JV-091 · https://github.com/grasdouble/Jarvis/issues/91';
  let reads=0;
  const result=await synchronizeMetadata({...h,write:true,load:async()=>{
    const snapshot=await h.load();
    if(reads++>0)snapshot.pullRequests[0].issueText='manual value';
    return snapshot;
  }});
  assert.equal(result.pending,0);assert.equal(result.verifiedPRs,0);
  assert.ok(result.diagnostics.some(diagnostic=>diagnostic.code==='manual_issue_text'));
});
test('lost response after an applied add is reconciled without a duplicate add',async()=>{
  const h=harness();let lost=true;
  const apply=async op=>{await h.apply(op);if(op.kind==='add'&&lost){lost=false;throw Object.assign(new Error('timeout'),{retryable:true});}};
  const r=await synchronizeMetadata({...h,apply,write:true});
  assert.equal(r.pending,0);assert.equal(h.effects.filter(e=>e.kind==='add').length,1);
});
test('a transient failure before effect retries only the missing step',async()=>{
  const h=harness();let calls=0;
  const apply=async op=>{if(calls++===0)throw Object.assign(new Error('rate limited'),{retryable:true,safeToRetry:true});await h.apply(op);};
  const r=await synchronizeMetadata({...h,apply,write:true});
  assert.equal(r.pending,0);assert.equal(calls,4);
});
test('repeated transient failures stop after three attempts and reread before retry',async()=>{
  const h=harness();let attempts=0,reads=0;
  const result=await synchronizeMetadata({...h,write:true,pause:async()=>{},load:async()=>{reads++;return h.load();},apply:async()=>{attempts++;throw Object.assign(new Error('rate limited'),{retryable:true,safeToRetry:true});}});
  assert.equal(attempts,3);assert.ok(reads>=4);
  assert.equal(result.mode,'incomplete');assert.equal(result.diagnostics[0].outcome,'confirmed_not_applied');
});
test('permanent failure records a reread but never repeats the mutation',async()=>{
  const h=harness();let attempts=0,reads=0;
  const result=await synchronizeMetadata({...h,write:true,load:async()=>{reads++;return h.load();},apply:async()=>{attempts++;throw new Error('denied');}});
  assert.equal(attempts,1);assert.ok(reads>=3);
  assert.equal(result.mode,'incomplete');assert.equal(result.diagnostics[0].outcome,'permanent_failure');
});
test('changed native issue milestone stops before any destination mutation',async()=>{
  const h=harness();let reads=0;
  const load=async()=>{const s=await h.load();if(reads++>0)s.pullRequests[0].issues[0].milestone.number=2;return s;};
  await assert.rejects(synchronizeMetadata({...h,load,write:true}),/changed/i);assert.equal(h.effects.length,0);
});
test('source drift during an uncertain effect is never retried against stale intent',async()=>{
  const h=harness();let calls=0;
  const apply=async()=>{calls++;h.state.pullRequests[0].issues[0].number=93;h.state.pullRequests[0].issues[0].url='https://github.com/grasdouble/Jarvis/issues/93';throw Object.assign(new Error('timeout'),{retryable:true});};
  await assert.rejects(synchronizeMetadata({...h,apply,write:true}),/changed/i);assert.equal(calls,1);
});
test('unreadable recovery state stops further writes',async()=>{
  const h=harness();let reads=0,calls=0;
  await assert.rejects(synchronizeMetadata({...h,write:true,load:async()=>{if(++reads===3)throw new Error('unavailable');return h.load();},apply:async()=>{calls++;throw Object.assign(new Error('timeout'),{retryable:true});}}),/unavailable/);assert.equal(calls,1);
});
test('ambiguous native relationships remain visible with no guessed metadata effects',async()=>{
  const h=harness();h.state.pullRequests[0].issues.push({...h.state.pullRequests[0].issues[0],number:93,url:'https://github.com/grasdouble/Jarvis/issues/93'});
  const r=await synchronizeMetadata({...h,write:true});assert.ok(r.diagnostics.some(d=>d.code==='ambiguous_issues'));assert.equal(h.effects.length,0);
});

for (const applied of [false,true]) test(`network metadata failure retains recovery after reread, applied=${applied}`,async()=>{
 const h=harness();let reads=0,writes=0;
 const failure=appNetworkError({status:75,stderr:'JARVIS_GITHUB_NETWORK: ENOTFOUND private-cause'});
 await assert.rejects(synchronizeMetadata({...h,write:true,
  load:async()=>{reads++;return h.load();},
  apply:async effect=>{writes++;if(applied)await h.apply(effect);throw failure;},
 }),error=>{
  assert.equal(error.networkFailure,true);assert.equal(error.exitCode,75);
  assert.match(error.message,/JARVIS_GITHUB_NETWORK:/);assert.doesNotMatch(error.message,/private-cause/);
  return true;
 });
 assert.equal(reads,3,'remote state must be reread before surfacing failure');
 assert.equal(writes,1,'never replay network-interrupted writes automatically');
 assert.equal(h.effects.length,applied?1:0);
});
