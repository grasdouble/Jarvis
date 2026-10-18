import {ROADMAP_CONFIG as C,planDates,sourceKey} from './roadmap-dates.mjs';
const info='pageInfo{hasNextPage endCursor}';
const events=`__typename ... on ProjectV2ItemStatusChangedEvent{createdAt previousStatus status project{id} wasAutomated}
 ... on ClosedEvent{createdAt closer{__typename ... on PullRequest{number mergedAt}}} ... on ReopenedEvent{createdAt}`;
const history=`timelineItems(first:100,itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT,CLOSED_EVENT,REOPENED_EVENT]){${info} nodes{${events}}}`;
const detail=`id number repository{nameWithOwner} state stateReason closedAt ${history}`;
const fields=`fields(first:100){${info} nodes{... on ProjectV2Field{id name dataType}}}`;
const itemFields=`id project{id} start:fieldValueByName(name:"Actual start"){__typename ... on ProjectV2ItemFieldDateValue{date}}
 completion:fieldValueByName(name:"Actual completion"){__typename ... on ProjectV2ItemFieldDateValue{date}}
 status:fieldValueByName(name:"Status"){__typename ... on ProjectV2ItemFieldSingleSelectValue{name}}`;
async function pages(fetch){let cursor=null;const seen=new Set(),nodes=[];for(let n=0;n<100;n++){
 const c=await fetch(cursor);if(!Array.isArray(c?.nodes)||typeof c.pageInfo?.hasNextPage!=='boolean'||c.nodes.some(x=>!x))throw new Error('Incomplete roadmap pagination.');
 nodes.push(...c.nodes);if(nodes.length>10000)throw new Error('Roadmap pagination limit.');if(!c.pageInfo.hasNextPage)return nodes;
 const next=c.pageInfo.endCursor;if(typeof next!=='string'||!next||seen.has(next))throw new Error('Invalid or repeated roadmap cursor.');seen.add(next);cursor=next;
 }throw new Error('Roadmap pagination limit.');}

export function createRoadmapApi({api}){
 const known=new Map(),proofs=new Map();
 async function query(q,variables={},write=false){const r=await api({method:'POST',path:'graphql',body:{query:q,variables},write});if(r.errors?.length||!r.data)throw new Error('Roadmap GitHub query failed.');return r.data;}
 function project(data){const p=data.organization?.projectV2;if(p?.id!==C.projectId||p.fields?.pageInfo?.hasNextPage!==false||!Array.isArray(p.fields.nodes))throw new Error('Incomplete or unexpected roadmap project fields.');
  for(const [id,name]of [[C.startFieldId,C.startFieldName],[C.completionFieldId,C.completionFieldName]]){
   const found=p.fields.nodes.filter(f=>f.name===name);if(found.length!==1||found[0].id!==id||found[0].dataType!=='DATE')throw new Error('Unexpected roadmap field identity/type.');
  }return p;
 }
 async function normalize(item,issue=item.content){
  if(!item||item.project?.id!==C.projectId||!issue||issue.repository?.nameWithOwner!==C.repository)throw new Error('Unexpected roadmap item scope.');
  for(const value of [item.start,item.completion])if(value&&value.__typename!=='ProjectV2ItemFieldDateValue')throw new Error('Invalid roadmap date value.');
  if(item.status&&item.status.__typename!=='ProjectV2ItemFieldSingleSelectValue')throw new Error('Invalid roadmap status value.');
  let first=true;
  const timeline=await pages(async after=>{if(first){first=false;return issue.timelineItems;}
   const d=await query(`query RoadmapHistory($number:Int!,$after:String){repository(owner:"grasdouble",name:"Jarvis"){issue(number:$number){timelineItems(first:100,after:$after,itemTypes:[PROJECT_V2_ITEM_STATUS_CHANGED_EVENT,CLOSED_EVENT,REOPENED_EVENT]){${info} nodes{${events}}}}}}`,{number:issue.number,after});return d.repository?.issue?.timelineItems;});
  return {id:issue.id,number:issue.number,repository:issue.repository.nameWithOwner,itemId:item.id,status:item.status?.name??null,
   state:issue.state,stateReason:issue.stateReason,closedAt:issue.closedAt,actualStart:item.start?.date??null,actualCompletion:item.completion?.date??null,history:timeline};
 }
 async function load(number){proofs.clear();let issues=[];
  if(number!==undefined){if(!Number.isSafeInteger(number)||number<1)throw new Error('Invalid roadmap issue number.');
   const existing=known.get(number);
   // Initial scoped reads discover membership; subsequent reads bind both item and native issue in one request.
   if(!existing){const all=await load();const found=all.issues.filter(i=>i.number===number);if(found.length!==1)throw new Error('Scoped roadmap issue membership unavailable.');issues=found;}
   else{
    const d=await query(`query RoadmapIssue($number:Int!,$itemId:ID!){organization(login:"grasdouble"){projectV2(number:1){id ${fields}}} node(id:$itemId){... on ProjectV2Item{${itemFields} content{... on Issue{id number repository{nameWithOwner}}}}} repository(owner:"grasdouble",name:"Jarvis"){issue(number:$number){${detail}}}}`,{number,itemId:existing.itemId});project(d);
    const native=d.repository?.issue;
    if(native?.id!==existing.id||native?.number!==number||d.node?.content?.id!==native.id||d.node?.id!==existing.itemId)throw new Error('Roadmap source membership changed.');
    issues=[await normalize(d.node,native)];
   }
  }else{
   const items=await pages(async after=>{const d=await query(`query RoadmapItems($after:String){organization(login:"grasdouble"){projectV2(number:1){id ${fields} items(first:20,after:$after){${info} nodes{${itemFields} content{__typename ... on Issue{${detail}}}}}}}}`,{after});return project(d).items;});
   const ids=new Set();for(const item of items){if(typeof item.id!=='string'||!item.id||ids.has(item.id))throw new Error('Invalid/duplicate roadmap membership.');ids.add(item.id);
    if(item.content?.__typename==='Issue'&&item.content.repository?.nameWithOwner===C.repository)issues.push(await normalize(item));}
  }
  const snapshot={projectId:C.projectId,startFieldId:C.startFieldId,completionFieldId:C.completionFieldId,issues};planDates(snapshot);
  for(const issue of issues){known.set(issue.number,{id:issue.id,itemId:issue.itemId});proofs.set(issue.number,structuredClone(issue));}
  return snapshot;
 }
 async function apply(effect){const proof=proofs.get(effect.number);if(!proof)throw new Error('Fresh roadmap snapshot proof required.');
  const expected=planDates({projectId:C.projectId,startFieldId:C.startFieldId,completionFieldId:C.completionFieldId,issues:[proof]}).updates[0];
  if(JSON.stringify(effect)!==JSON.stringify(expected))throw new Error('Roadmap effect is not the proven date update.');proofs.delete(effect.number);
  const variables={projectId:C.projectId,itemId:effect.itemId};const definitions=['$projectId:ID!','$itemId:ID!'];const mutations=[];
  for(const [key,change]of Object.entries(effect.fields)){
   const index=mutations.length;variables[`field${index}`]=key==='start'?C.startFieldId:C.completionFieldId;definitions.push(`$field${index}:ID!`);
   if(change.after===null)mutations.push(`u${index}:clearProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$field${index}}){projectV2Item{id}}`);
   else{variables[`date${index}`]=change.after;definitions.push(`$date${index}:Date!`);mutations.push(`u${index}:updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$field${index},value:{date:$date${index}}}){projectV2Item{id}}`);}
  }
  return query(`mutation RoadmapDates(${definitions.join(',')}){${mutations.join('\n')}}`,variables,true);
 }
 return {load,apply};
}

export async function synchronizeDates({load,apply,write=false,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 const initial=await load(),plan=planDates(initial);const result={mode:write?'unchanged':'preview',attemptedWrites:0,verifiedIssues:0,pending:plan.updates.length,diagnostics:plan.diagnostics};
 if(!write||!plan.updates.length)return result;
 for(const original of plan.updates){const expected=sourceKey(initial.issues.find(i=>i.number===original.number));
  const current=async()=>{const snapshot=await load(original.number),next=planDates(snapshot);const issue=snapshot.issues.find(i=>i.number===original.number);
   if(!issue||sourceKey(issue)!==expected)throw new Error(`Native roadmap source changed for issue #${original.number}.`);return next.updates.find(i=>i.number===original.number);};
  let update=await current(),failures=0,attempts=0;
  while(update){if(++attempts>8)throw new Error('Roadmap mutation limit exhausted.');let failure;result.attemptedWrites++;
   try{await apply(update);}catch(e){failure=e;}update=await current();
   if(failure){if(failure.networkFailure)throw failure;if(failure.retryable!==true)throw new Error(`Roadmap write failed for issue #${original.number}.`);if(++failures>=3)throw new Error('Roadmap retry limit exhausted.');if(update)await pause(250*failures);}
  }result.verifiedIssues++;
 }
 const final=planDates(await load());result.pending=final.updates.length;result.diagnostics=final.diagnostics;
 if(result.pending)throw new Error('Roadmap dates changed during reconciliation; inspect partial progress.');result.mode='synchronized';return result;
}
