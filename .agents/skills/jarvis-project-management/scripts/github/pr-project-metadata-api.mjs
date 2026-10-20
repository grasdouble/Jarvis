import { CONFIG, planMetadata } from './pr-project-metadata.mjs';
const pageInfo='pageInfo{hasNextPage endCursor}';
const milestone='milestone{id number title}';
const issue=`number url repository{nameWithOwner} ${milestone}`;
const details=`id number repository{nameWithOwner} ${milestone}
  labels(first:100){${pageInfo} nodes{name}}
  closingIssuesReferences(first:100){${pageInfo} nodes{${issue}}}`;
const scopedDetails=`${details}
  projectItems(first:100){${pageInfo} nodes{id isArchived project{id number}
    fieldValueByName(name:"Issue"){__typename ... on ProjectV2ItemFieldTextValue{text}}}}`;
const args='$after:String';
const project='organization(login:"grasdouble"){projectV2(number:1)';
const repository='repository(owner:"grasdouble",name:"Jarvis")';
function checkConnection(c) {
  if (!c || !Array.isArray(c.nodes) || typeof c.pageInfo?.hasNextPage!=='boolean' || c.nodes.some(n=>!n))
    throw new Error('Incomplete API connection; synchronization stopped.');
}
async function collect(fetch) {
  let cursor=null;const seen=new Set(),nodes=[];
  for(let page=0;page<100;page++) {
    const c=await fetch(cursor);checkConnection(c);nodes.push(...c.nodes);
    if(nodes.length>10000)throw new Error('Pagination item limit exceeded.');
    if(!c.pageInfo.hasNextPage)return nodes;
    const next=c.pageInfo.endCursor;
    if(typeof next!=='string'||!next||seen.has(next))throw new Error('Invalid or repeated pagination cursor.');
    seen.add(next);cursor=next;
  }
  throw new Error('Pagination page limit exceeded.');
}
function positive(n) { return Number.isSafeInteger(n)&&n>0; }

/** API port accepts structured requests, never repository text or arbitrary destinations. */
export function createMetadataApi({api}) {
  const proofs=new Map();
  async function graphql(query,variables={},write=false) {
    const response=await api({method:'POST',path:'graphql',body:{query,variables},write});
    if(response.errors?.length){
      const retryable=response.errors.every(e=>['RATE_LIMITED','SERVICE_UNAVAILABLE'].includes(e.type));
      const safeToRetry=retryable&&response.errors.every(e=>e.type==='RATE_LIMITED');
      throw Object.assign(new Error('GitHub GraphQL request failed.'),
        {retryable,safeToRetry,ambiguous:retryable&&!safeToRetry});
    }
    if(!response.data)throw new Error('Missing GitHub GraphQL data.');
    return response.data;
  }
  const getProject=data=>{
    const p=data.organization?.projectV2;
    if(p?.id!==CONFIG.projectId)throw new Error('Unexpected project identity.');
    return p;
  };
  async function load(number) {
    proofs.clear();
    if(number!==undefined&&!positive(number))throw new Error('Invalid scoped pull request number.');
    const fields=await collect(async after=>getProject(await graphql(
      `query ProjectFields(${args}){${project}{id fields(first:100,after:$after){${pageInfo} nodes{... on ProjectV2Field{id name dataType}}}}}}`,{after})).fields);
    const named=fields.filter(f=>f.name===CONFIG.fieldName);
    if(named.length!==1||named[0].id!==CONFIG.fieldId||named[0].dataType!=='TEXT')throw new Error('Unexpected Issue field identity or type.');
    const items=await collect(async after=>getProject(await graphql(
      `query ProjectItems(${args}){${project}{id items(first:100,after:$after){${pageInfo} nodes{id
        content{__typename ... on PullRequest{id number repository{nameWithOwner}}}
        fieldValueByName(name:"Issue"){__typename ... on ProjectV2ItemFieldTextValue{text}}}}}}}`,{after})).items);
    const memberships=new Map(),itemIds=new Set();
    for(const item of items) {
      if(typeof item.id!=='string'||!item.id||itemIds.has(item.id))throw new Error('Invalid or duplicate project item.');
      itemIds.add(item.id);
      const c=item.content;
      if(c?.__typename!=='PullRequest'||c.repository?.nameWithOwner!==CONFIG.repository)continue;
      if(memberships.has(c.id))throw new Error('Duplicate project membership.');
      if(item.fieldValueByName&&item.fieldValueByName.__typename!=='ProjectV2ItemFieldTextValue')throw new Error('Unexpected Issue field value type.');
      memberships.set(c.id,item);
    }
    let prs;
    if(number!==undefined) {
      const data=await graphql(`query PullRequest($number:Int!){${repository}{pullRequest(number:$number){${scopedDetails}}}}`,{number});
      if(!data.repository?.pullRequest)throw new Error('Scoped pull request unavailable.');
      prs=[data.repository.pullRequest];
    } else prs=await collect(async after=>{
      const data=await graphql(`query PullRequests(${args}){${repository}{pullRequests(first:100,after:$after){${pageInfo} nodes{${details}}}}}`,{after});
      return data.repository?.pullRequests;
    });
    const normalized=[];
    for(const pr of prs) {
      if(number!==undefined&&pr.number!==number)throw new Error('Unexpected scoped pull request.');
      const connection=async (name,initial,selection)=>{
        let first=true;
        return collect(async after=>{
          if(first){first=false;return initial;}
          const data=await graphql(`query PullRequestConnection($number:Int!,$after:String){${repository}{pullRequest(number:$number){${name}(first:100,after:$after){${pageInfo} nodes{${selection}}}}}}`,{number:pr.number,after});
          return data.repository?.pullRequest?.[name];
        });
      };
      const labels=await connection('labels',pr.labels,'name');
      const issues=await connection('closingIssuesReferences',pr.closingIssuesReferences,issue);
      let item=memberships.get(pr.id);
      if(number!==undefined){
        const relatedItems=await connection('projectItems',pr.projectItems,
          'id isArchived project{id number} fieldValueByName(name:"Issue"){__typename ... on ProjectV2ItemFieldTextValue{text}}');
        for(const related of relatedItems){
          if(typeof related.id!=='string'||!related.id||typeof related.isArchived!=='boolean'||
            typeof related.project?.id!=='string'||
            !positive(related.project.number))throw new Error('Invalid scoped project membership.');
          if(related.project.id===CONFIG.projectId&&related.project.number!==CONFIG.projectNumber)
            throw new Error('Unexpected scoped project identity.');
        }
        const matches=relatedItems.filter(related=>related.project.id===CONFIG.projectId);
        if(matches.length>1)throw new Error(`Duplicate scoped project membership for PR #${pr.number}.`);
        const related=matches[0];
        if(related?.isArchived)throw new Error(`Archived project membership for PR #${pr.number}; synchronization stopped.`);
        if(item&&related&&(item.id!==related.id||
          (item.fieldValueByName?.text??null)!==(related.fieldValueByName?.text??null)))
          throw new Error(`Project membership reads disagree for PR #${pr.number}; synchronization stopped.`);
        if(related){
          if(related.fieldValueByName&&related.fieldValueByName.__typename!=='ProjectV2ItemFieldTextValue')
            throw new Error('Unexpected scoped Issue field value type.');
          item=related;
        }
      }
      normalized.push({id:pr.id,number:pr.number,repository:pr.repository?.nameWithOwner,
        milestone:pr.milestone,labels:labels.map(l=>l.name),
        issues:issues.map(i=>({...i,repository:i.repository?.nameWithOwner})),
        projectItemId:item?.id??null,issueText:item?.fieldValueByName?.text??null});
    }
    const snapshot={projectId:CONFIG.projectId,fieldId:CONFIG.fieldId,pullRequests:normalized};
    planMetadata(snapshot); // Validate the entire response before retaining write proofs.
    for(const pr of normalized)proofs.set(pr.number,pr);
    return snapshot;
  }
  async function apply(effect) {
    const pr=proofs.get(effect.number);
    if(!pr)throw new Error('Fresh snapshot proof required before a write.');
    const update=planMetadata({projectId:CONFIG.projectId,fieldId:CONFIG.fieldId,pullRequests:[pr]}).updates[0];
    const expected=!update?null:update.addToProject?{kind:'add',number:pr.number,pullRequestId:pr.id}:
      update.milestone?{kind:'milestone',number:pr.number,milestoneNumber:update.milestone.after}:
      {kind:'issue',number:pr.number,itemId:pr.projectItemId,text:update.issue.after};
    if(JSON.stringify(effect)!==JSON.stringify(expected))throw new Error('Effect is not the next proven metadata mutation.');
    proofs.delete(pr.number);
    if(effect.kind==='add')return graphql(`mutation AddItem($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`,
      {projectId:CONFIG.projectId,contentId:pr.id},true);
    if(effect.kind==='milestone')return api({method:'PATCH',path:`repos/${CONFIG.repository}/issues/${pr.number}`,body:{milestone:effect.milestoneNumber},write:true});
    const variables={projectId:CONFIG.projectId,fieldId:CONFIG.fieldId,itemId:pr.projectItemId};
    if(effect.text===null)return graphql(`mutation ClearIssue($projectId:ID!,$fieldId:ID!,$itemId:ID!){clearProjectV2ItemFieldValue(input:{projectId:$projectId,fieldId:$fieldId,itemId:$itemId}){projectV2Item{id}}}`,variables,true);
    return graphql(`mutation SetIssue($projectId:ID!,$fieldId:ID!,$itemId:ID!,$text:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,fieldId:$fieldId,itemId:$itemId,value:{text:$text}}){projectV2Item{id}}}`,{...variables,text:effect.text},true);
  }
  return {load,apply};
}
