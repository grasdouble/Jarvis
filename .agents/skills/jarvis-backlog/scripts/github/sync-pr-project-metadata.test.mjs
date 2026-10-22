import test from 'node:test';
import assert from 'node:assert/strict';
import {apiInvocation,parseOptions,assertCiContext,requestError} from './sync-pr-project-metadata.mjs';
import {createRoadmapApi} from './roadmap-dates-sync.mjs';
import {ROADMAP_CONFIG as ROADMAP} from './roadmap-dates.mjs';
import {isRoadmapQuery} from './gh-app.mjs';
async function captureRoadmapQueries(){
 const page=(nodes,next=false,cursor=null)=>({nodes,pageInfo:{hasNextPage:next,endCursor:cursor}});
 const fields=page([{id:ROADMAP.startFieldId,name:ROADMAP.startFieldName,dataType:'DATE'},
  {id:ROADMAP.completionFieldId,name:ROADMAP.completionFieldName,dataType:'DATE'}]);
 const issue={id:'I_test',number:93,repository:{nameWithOwner:ROADMAP.repository},state:'OPEN',stateReason:null,closedAt:null,
  timelineItems:page([],true,'history-cursor')};
 const item={id:'ITEM_test',project:{id:ROADMAP.projectId},start:null,completion:null,status:null,
  content:{__typename:'Issue',...issue}};
 const requests=[];
 const roadmap=createRoadmapApi({api:async request=>{
  requests.push(request);
  if(request.body.query.includes('query RoadmapItems'))
   return {data:{organization:{projectV2:{id:ROADMAP.projectId,fields,items:page([item])}}}};
  if(request.body.query.includes('query RoadmapHistory'))
   return {data:{repository:{issue:{timelineItems:page([])}}}};
  if(request.body.query.includes('query RoadmapIssue'))
   return {data:{organization:{projectV2:{id:ROADMAP.projectId,fields}},node:item,
    repository:{issue:{...issue,timelineItems:page([])}}}};
  throw new Error('Unexpected fixture query.');
 }});
 await roadmap.load();await roadmap.load(issue.number);
 return Object.fromEntries(['RoadmapItems','RoadmapIssue','RoadmapHistory'].map(name=>[
  name,requests.find(request=>request.body.query.includes(`query ${name}`)),
 ]));
}
test('CLI accepts only explicit fixed-scope options and safe PR numbers',()=>{
  assert.deepEqual(parseOptions(['--pr','92','--write']),{write:true,ci:false,number:92});
  for(const args of [['--pr','0'],['--pr','9007199254740992'],['--pr','1;echo'],['--write','--write'],['--repo','other']])assert.throws(()=>parseOptions(args));
});
const trusted=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'grasdouble/Jarvis',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'grasdouble/Jarvis/.github/workflows/pr-project-metadata.yml@refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GH_TOKEN:'synthetic-token'});
test('CI rejects candidate refs, fork contexts, owner-token fallback and unrelated events',()=>{
  assert.doesNotThrow(()=>assertCiContext(trusted()));
  for(const override of [{GITHUB_REF:'refs/heads/candidate'},{GITHUB_REPOSITORY:'attacker/Jarvis'},{GITHUB_WORKFLOW_REF:'grasdouble/Jarvis/.github/workflows/other.yml@refs/heads/main'},{GH_TOKEN:''},{GITHUB_EVENT_NAME:'pull_request'}])assert.throws(()=>assertCiContext({...trusted(),...override}));
});
test('transport diagnostics discard raw secrets and distinguish transient failures',()=>{
  const e=requestError({stderr:'HTTP 503 synthetic-secret'});assert.equal(e.retryable,true);assert.equal(e.safeToRetry,false);assert.equal(e.ambiguous,true);assert.ok(!e.message.includes('synthetic-secret'));
  const limited=requestError({stderr:'HTTP 429 synthetic-secret'});assert.equal(limited.retryable,true);assert.equal(limited.safeToRetry,true);assert.equal(limited.ambiguous,false);
  assert.equal(requestError({stderr:'HTTP 403 synthetic-secret'}).retryable,false);
});

test('roadmap mode scopes issue dates without allowing PR-mode confusion',()=>{
 assert.deepEqual(parseOptions(['--roadmap','--issue','93','--write']),{write:true,ci:false,roadmap:true,number:93});
 for(const args of [['--roadmap','--pr','93'],['--issue','93'],['--roadmap','--issue','93','--pr','92']])assert.throws(()=>parseOptions(args));
});

test('only validated read-only Roadmap queries use the dedicated helper mode',async()=>{
 const helper='/trusted/gh-app.mjs';
 const queries=await captureRoadmapQueries();
 const query=queries.RoadmapItems;
 assert.deepEqual(apiInvocation({ci:false,roadmap:true,write:false},query,helper),
  {command:process.execPath,args:[helper,'--roadmap-query']});
 assert.deepEqual(apiInvocation({ci:false,roadmap:true,write:true},query,helper),
  {command:process.execPath,args:[helper,'--roadmap-query']});
 for(const name of ['RoadmapIssue','RoadmapHistory'])
  assert.deepEqual(apiInvocation({ci:false,roadmap:true,write:false},queries[name],helper),
   {command:process.execPath,args:[helper,'--roadmap-query']});
 for(const [options,request] of [
  [{ci:true,roadmap:true,write:false},query],
  [{ci:false,roadmap:false,write:false},query],
  [{ci:false,roadmap:true,write:true},{...query,write:true,body:{...query.body,query:'mutation RoadmapDates{updateProjectV2ItemFieldValue{id}}'}}],
  [{ci:false,roadmap:true,write:false},{...query,path:'repos/x'}],
  ])assert.notDeepEqual(apiInvocation(options,request,helper).args,[helper,'--roadmap-query']);
  for(const invalid of [
   {...query,body:{...query.body,query:'mutation RoadmapDates{updateProjectV2ItemFieldValue{id}}'}},
   {...query,body:{...query.body,query:'query UnknownOperation{viewer{login}}'}},
   {...query,body:{...query.body,query:'query RoadmapItems($after:String){viewer{login}}'}},
  ])assert.throws(()=>apiInvocation({ci:false,roadmap:true,write:false},invalid,helper),/unrecognized Roadmap GraphQL read/);
});

test('actual Roadmap preview query passes helper validation and routes through retry mode',async()=>{
 const fields={pageInfo:{hasNextPage:false,endCursor:null},nodes:[
  {id:ROADMAP.startFieldId,name:ROADMAP.startFieldName,dataType:'DATE'},
  {id:ROADMAP.completionFieldId,name:ROADMAP.completionFieldName,dataType:'DATE'},
 ]};
 let emitted;
 const roadmap=createRoadmapApi({api:async request=>{
  emitted=request;
  return {data:{organization:{projectV2:{id:ROADMAP.projectId,fields,
   items:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}}};
 }});
 const snapshot=await roadmap.load();
 assert.deepEqual(snapshot.issues,[]);
 assert.equal(emitted.write,false);
 assert.equal(emitted.method,'POST');
 assert.equal(emitted.path,'graphql');
 assert.equal(isRoadmapQuery(emitted.body),true);
 const reformatted={...emitted.body,query:emitted.body.query.replace('query RoadmapItems','query # harmless comment\n RoadmapItems').replace(/\{/g,' { ').replace(/,/g,', ')};
 assert.equal(isRoadmapQuery(reformatted),true,'insignificant GraphQL formatting preserves the allowlisted shape');
 assert.deepEqual(apiInvocation({ci:false,roadmap:true,write:false},emitted,'/trusted/gh-app.mjs'),
  {command:process.execPath,args:['/trusted/gh-app.mjs','--roadmap-query']});
 const expanded={...emitted,body:{...emitted.body,query:emitted.body.query.replace(/}$/, ' viewer { login }}')}};
 assert.equal(isRoadmapQuery(expanded.body),false);
 assert.throws(()=>apiInvocation({ci:false,roadmap:true,write:false},expanded,'/trusted/gh-app.mjs'),
  /unrecognized Roadmap GraphQL read/);
});


test('App network failures retain safe recovery guidance without automatic retries', () => {
  const result = requestError({status:75, stderr:'JARVIS_GITHUB_NETWORK: EAI_AGAIN synthetic-secret'});
  assert.equal(result.networkFailure, true);
  assert.equal(result.retryable, false);
  assert.match(result.message, /JARVIS_GITHUB_NETWORK:/);
  assert.match(result.message, /--check-network/);
  assert.ok(!result.message.includes('synthetic-secret'));
  assert.notEqual(requestError({status:1, stderr:'HTTP 403 JARVIS_GITHUB_NETWORK:'}).networkFailure, true);
});
