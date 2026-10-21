import { appNetworkError } from './gh-app.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadmapApi,synchronizeDates} from './roadmap-dates-sync.mjs';
const projectId='PVT_kwDOAvfTzc4BnQz1',startFieldId='PVTF_lADOAvfTzc4BnQz1zhmCUrk',completionFieldId='PVTF_lADOAvfTzc4BnQz1zhmCUr0';
const page=(nodes,next=false,cursor=null)=>({nodes,pageInfo:{hasNextPage:next,endCursor:cursor}});
const fixture=()=>({projectId,startFieldId,completionFieldId,issues:[{id:'I_test',number:93,repository:'grasdouble/Jarvis',itemId:'ITEM_test',status:'In Progress',state:'OPEN',stateReason:null,closedAt:null,actualStart:null,actualCompletion:null,history:[{__typename:'ProjectV2ItemStatusChangedEvent',createdAt:'2026-10-16T23:30:00Z',previousStatus:'Ready',status:'In Progress',project:{id:projectId},wasAutomated:false}]}]});
function harness(){const state=fixture(),effects=[];return {state,effects,load:async()=>structuredClone(state),apply:async e=>{effects.push(e);for(const [k,v]of Object.entries(e.fields))state.issues[0][k==='start'?'actualStart':'actualCompletion']=v.after;}};}
test('observed start is synchronized once without setting a planned date or status',async()=>{
 const h=harness();assert.equal((await synchronizeDates({...h,write:true})).pending,0);assert.equal(h.effects.length,1);assert.equal(h.state.issues[0].actualStart,'2026-10-17');
 assert.deepEqual(Object.keys(h.effects[0]).sort(),['fields','id','itemId','number']);assert.equal((await synchronizeDates({...h,write:true})).attemptedWrites,0);assert.equal(h.state.issues[0].status,'In Progress');
});
test('preview has no mutation and reports pending realization dates',async()=>{const h=harness();const r=await synchronizeDates({...h});assert.equal(r.pending,1);assert.equal(h.effects.length,0);});
test('an uncertain applied effect is reconciled rather than repeated',async()=>{const h=harness();let once=true;const apply=async e=>{await h.apply(e);if(once){once=false;throw Object.assign(new Error('timeout'),{retryable:true});}};await synchronizeDates({...h,apply,write:true});assert.equal(h.effects.length,1);});
test('source drift and unreadable recovery stop writes',async()=>{
 const h=harness();let reads=0;await assert.rejects(synchronizeDates({...h,write:true,load:async()=>{const s=await h.load();if(reads++)s.issues[0].status='Blocked';return s;}}),/changed/);assert.equal(h.effects.length,0);
});
test('permanent errors are not retried and transient failures are bounded',async()=>{
 for(const retryable of [false,true]){const h=harness();let attempts=0;await assert.rejects(synchronizeDates({...h,write:true,pause:async()=>{},apply:async()=>{attempts++;throw Object.assign(new Error('failure'),{retryable});}}),/failed|limit/);assert.equal(attempts,retryable?3:1);}
});
function apiHarness({repeat=false,badField=false,historyPages=false,changedMembership=false}={}){
 const calls=[];const issue=fixture().issues[0];
 const content={...issue,repository:{nameWithOwner:issue.repository},timelineItems:page(issue.history,historyPages,historyPages?'history2':null)};
 const item={id:'ITEM_test',project:{id:projectId},start:null,completion:null,status:{__typename:'ProjectV2ItemFieldSingleSelectValue',name:'In Progress'},content:{__typename:'Issue',...content}};
 const fields=page([{id:startFieldId,name:'Actual start',dataType:badField?'TEXT':'DATE'},{id:completionFieldId,name:'Actual completion',dataType:'DATE'}]);
 const api=async r=>{calls.push(r);const {query,variables:v}=r.body;if(r.write)return {data:{u0:{projectV2Item:{id:'ITEM_test'}}}};
  if(query.includes('query RoadmapItems'))return {data:{organization:{projectV2:{id:projectId,fields,items:v.after===null?page([item],true,'second'):page([],repeat,'second')}}}};
  if(query.includes('query RoadmapIssue'))return {data:{organization:{projectV2:{id:projectId,fields}},node:changedMembership?{...item,content:{...item.content,id:'I_other'}}:item,repository:{issue:content}}};
  if(query.includes('query RoadmapHistory'))return {data:{repository:{issue:{timelineItems:page([])}}}};
  throw new Error('Unexpected query');};
 return {calls,...createRoadmapApi({api})};
}
test('API fully paginates item inventory and only authorizes proven actual-date mutations',async()=>{
 const h=apiHarness();await assert.rejects(h.apply({number:93}),/proof|snapshot/);const s=await h.load();assert.equal(s.issues[0].number,93);assert.equal(h.calls.length,2);
 await assert.rejects(h.apply({number:93,id:'I_test',itemId:'ITEM_test',fields:{status:{after:'Done'}}}),/proven|effect/);
 await h.apply({number:93,id:'I_test',itemId:'ITEM_test',fields:{start:{before:null,after:'2026-10-17'}}});
 const request=h.calls.at(-1);assert.equal(request.write,true);assert.equal(request.body.variables.projectId,projectId);assert.equal(request.body.variables.field0,startFieldId);
});
test('invalid field types and repeated cursors fail closed',async()=>{await assert.rejects(apiHarness({badField:true}).load(),/field/);await assert.rejects(apiHarness({repeat:true}).load(),/cursor/);});
test('partial date effects retry only the remaining proven field',async()=>{
 const h=harness(),i=h.state.issues[0];Object.assign(i,{state:'CLOSED',stateReason:'COMPLETED',status:'Done',closedAt:'2026-10-17T09:00:00Z'});i.history.push({__typename:'ClosedEvent',createdAt:i.closedAt,closer:{__typename:'PullRequest',number:94,mergedAt:'2026-10-17T08:59:59Z'}});
 let calls=0;const apply=async e=>{if(calls++===0){h.effects.push(e);i.actualStart=e.fields.start.after;throw Object.assign(new Error('lost partial response'),{retryable:true});}await h.apply(e);};
 await synchronizeDates({...h,apply,write:true,pause:async()=>{}});assert.equal(calls,2);assert.deepEqual(Object.keys(h.effects[1].fields),['completion']);assert.equal(i.actualCompletion,'2026-10-17');
});
test('unreadable recovery state never repeats an uncertain write',async()=>{
 const h=harness();let reads=0,calls=0;await assert.rejects(synchronizeDates({...h,write:true,load:async()=>{if(++reads===3)throw new Error('recovery unavailable');return h.load();},apply:async()=>{calls++;throw Object.assign(new Error('timeout'),{retryable:true});}}),/unavailable/);assert.equal(calls,1);
});
test('API traverses native history pages and binds scoped reads to discovered membership',async()=>{
 const h=apiHarness({historyPages:true});const original=h.load;await original(93);
 // The scoped read is bound to the discovered node and issue identity.
 const s=await original(93);assert.equal(s.issues[0].itemId,'ITEM_test');assert.ok(h.calls.some(r=>r.body.variables.itemId==='ITEM_test'));assert.ok(h.calls.some(r=>r.body.query.includes('query RoadmapHistory')&&r.body.variables.after==='history2'));
});

test('changed native membership fails before a date mutation',async()=>{
 const h=apiHarness({changedMembership:true});await h.load();await assert.rejects(h.load(93),/membership changed/);assert.equal(h.calls.filter(r=>r.write).length,0);
});

for (const applied of [false,true]) test(`network roadmap failure retains recovery after reread, applied=${applied}`,async()=>{
 const h=harness();let reads=0,writes=0;
 const failure=appNetworkError({status:75,stderr:'JARVIS_GITHUB_NETWORK: ENOTFOUND private-cause'});
 await assert.rejects(synchronizeDates({...h,write:true,
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
