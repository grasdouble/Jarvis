import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataApi } from './pr-project-metadata-api.mjs';
import { CONFIG } from './pr-project-metadata.mjs';
const page=(nodes,next=false,cursor=null)=>({nodes,pageInfo:{hasNextPage:next,endCursor:cursor}});
const pr=()=>({id:'PR_test',number:92,repository:{nameWithOwner:CONFIG.repository},milestone:null,labels:page([]),closingIssuesReferences:page([{number:91,url:`https://github.com/${CONFIG.repository}/issues/91`,repository:{nameWithOwner:CONFIG.repository},milestone:{id:'M_test',number:1,title:'J00'}}])});
function harness({repeatedCursor=false,wrongField=false}={}) {
  const requests=[];
  const api=async request=>{
    requests.push(request);const {query,variables:v}=request.body;
    if(query.includes('query ProjectFields'))return {data:{organization:{projectV2:{id:CONFIG.projectId,fields:page([{id:wrongField?'wrong':CONFIG.fieldId,name:'Issue',dataType:'TEXT'}])}}}};
    if(query.includes('query ProjectItems'))return {data:{organization:{projectV2:{id:CONFIG.projectId,items:v.after===null?page([],true,'cursor1'):page([],repeatedCursor,'cursor1')}}}};
    if(query.includes('query PullRequests'))return {data:{repository:{pullRequests:page([pr()])}}};
    if(query.includes('query PullRequest'))return {data:{repository:{pullRequest:pr()}}};
    if(query.includes('mutation AddItem'))return {data:{addProjectV2ItemById:{item:{id:'ITEM_test'}}}};
    throw new Error('Unexpected API request');
  };
  return {requests,...createMetadataApi({api})};
}
test('loads every project page and normalizes native issue relationships',async()=>{
  const h=harness(),s=await h.load();
  assert.equal(s.projectId,CONFIG.projectId);assert.equal(s.pullRequests[0].issues[0].number,91);
  assert.equal(h.requests.filter(r=>r.body.query.includes('query ProjectItems')).length,2);
});
test('repeated cursors fail closed rather than loop or silently truncate',async()=>{
  await assert.rejects(harness({repeatedCursor:true}).load(),/cursor|pagination/i);
});
test('unexpected Issue field identity stops before any write',async()=>{
  await assert.rejects(harness({wrongField:true}).load(),/field/i);
});
test('rate-limit failures are safe to retry while service failures remain ambiguous',async()=>{
  for(const [type,safeToRetry] of [['RATE_LIMITED',true],['SERVICE_UNAVAILABLE',false]]){
    const adapter=createMetadataApi({api:async()=>({errors:[{type}]})});
    await assert.rejects(adapter.load(),error=>{
      assert.equal(error.retryable,true);assert.equal(error.safeToRetry,safeToRetry);
      assert.equal(error.ambiguous,!safeToRetry);return true;
    });
  }
});
test('writes require fresh scope evidence and use only the next proven mutation',async()=>{
  const h=harness();
  await assert.rejects(h.apply({kind:'add',number:92,pullRequestId:'PR_test'}),/proof|snapshot/i);
  await h.load(92);
  await assert.rejects(h.apply({kind:'issue',number:92,itemId:'foreign',text:'x'}),/proven|effect/i);
  await h.apply({kind:'add',number:92,pullRequestId:'PR_test'});
  assert.equal(h.requests.at(-1).body.variables.projectId,CONFIG.projectId);
  await assert.rejects(h.apply({kind:'add',number:92,pullRequestId:'PR_test'}),/proof|snapshot/i);
});
test('follows PR, label and native issue cursors instead of selecting a truncated source',async()=>{
  const calls=[];
  const api=async request=>{
    calls.push(request);const {query,variables:v}=request.body;
    if(query.includes('query ProjectFields'))return {data:{organization:{projectV2:{id:CONFIG.projectId,fields:page([{id:CONFIG.fieldId,name:'Issue',dataType:'TEXT'}])}}}};
    if(query.includes('query ProjectItems'))return {data:{organization:{projectV2:{id:CONFIG.projectId,items:page([])}}}};
    if(query.includes('query PullRequests')){
      const one=pr();one.labels=page([{name:'area:foundation'}],true,'labels2');
      one.closingIssuesReferences=page(one.closingIssuesReferences.nodes,true,'issues2');
      return {data:{repository:{pullRequests:v.after===null?page([one],true,'prs2'):page([])}}};
    }
    if(query.includes('labels(first:100,after:'))return {data:{repository:{pullRequest:{labels:page([{name:'self-update'}])}}}};
    if(query.includes('closingIssuesReferences(first:100,after:'))return {data:{repository:{pullRequest:{closingIssuesReferences:page([{...pr().closingIssuesReferences.nodes[0],number:93,url:`https://github.com/${CONFIG.repository}/issues/93`}])}}}};
    throw new Error('Unexpected query');
  };
  const s=await createMetadataApi({api}).load();
  assert.deepEqual(s.pullRequests[0].labels,['area:foundation','self-update']);
  assert.equal(s.pullRequests[0].issues.length,2);
  assert.equal(calls.filter(r=>r.body.query.includes('query PullRequests')).length,2);
});
test('adapter and synchronizer converge through only membership, milestone and Issue effects',async()=>{
  const {synchronizeMetadata}=await import('./pr-project-metadata-sync.mjs');
  let itemId=null,m=null,text=null;const mutations=[];
  const adapter=createMetadataApi({api:async request=>{
    if(request.method==='PATCH'){
      mutations.push(request);assert.deepEqual(Object.keys(request.body),['milestone']);
      m={id:'M_test',number:request.body.milestone,title:'J00'};return {};
    }
    const {query,variables:v}=request.body;
    if(query.includes('query ProjectFields'))return {data:{organization:{projectV2:{id:CONFIG.projectId,fields:page([{id:CONFIG.fieldId,name:'Issue',dataType:'TEXT'}])}}}};
    if(query.includes('query ProjectItems'))return {data:{organization:{projectV2:{id:CONFIG.projectId,items:page(itemId?[{id:itemId,content:{__typename:'PullRequest',id:'PR_test',number:92,repository:{nameWithOwner:CONFIG.repository}},fieldValueByName:text===null?null:{__typename:'ProjectV2ItemFieldTextValue',text}}]:[])}}}};
    if(query.includes('query PullRequest')){const p=pr();p.milestone=m;return {data:{repository:query.includes('query PullRequests')?{pullRequests:page([p])}:{pullRequest:p}}};}
    mutations.push(request);
    assert.equal(v.projectId,CONFIG.projectId);
    if(query.includes('mutation AddItem')){itemId='ITEM_test';return {data:{addProjectV2ItemById:{item:{id:itemId}}}};}
    if(query.includes('mutation SetIssue')){assert.equal(v.fieldId,CONFIG.fieldId);assert.equal(v.itemId,itemId);text=v.text;return {data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:itemId}}}};}
    throw new Error('Unexpected effect');
  }});
  assert.equal((await synchronizeMetadata({...adapter,write:true})).pending,0);
  assert.equal(mutations.length,3);assert.equal(text,`JV-091 · https://github.com/${CONFIG.repository}/issues/91`);
  assert.equal((await synchronizeMetadata({...adapter,write:true})).attemptedWrites,0);
});
