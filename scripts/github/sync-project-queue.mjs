#!/usr/bin/env node
/** Trusted contributor tooling; never executes code from issues or analyzed repositories. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planQueue } from './project-queue.mjs';

const args = process.argv.slice(2);
if (args.some(x => x !== '--write')) throw new Error('Usage: node scripts/github/sync-project-queue.mjs [--write]');
const write = args.includes('--write');
const helper = fileURLToPath(new URL('./gh-app.mjs', import.meta.url));
function gh(values, mutate = false) {
  return JSON.parse(execFileSync(process.execPath, [helper, ...(mutate ? ['--write'] : []), '--', ...values],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
function graphql(query, mutate = false) {
  const result = gh(['api', 'graphql', '-f', `query=${query}`], mutate);
  if (result.errors?.length) throw new Error('GitHub returned GraphQL errors; inspect state before retrying.');
  return result.data;
}
function complete(connection, name) {
  if (!connection || connection.pageInfo.hasNextPage) throw new Error(`Incomplete ${name}; no queue writes performed.`);
  return connection.nodes;
}
const pageInfo = 'pageInfo{hasNextPage endCursor}';
function load() {
  const project = graphql(`{organization(login:"grasdouble"){projectV2(number:1){id
    fields(first:100){${pageInfo} nodes{... on ProjectV2Field{id name dataType}}}}}}`).organization.projectV2;
  if (!project) throw new Error('JARVIS development project unavailable.');
  const field = complete(project.fields, 'project fields').find(x => x.name === 'Execution order');
  if (!field || field.dataType !== 'NUMBER') throw new Error('Create the Execution order NUMBER field first.');
  let cursor = null;
  const items = [];
  do {
    const connection = graphql(`{organization(login:"grasdouble"){projectV2(number:1){items(first:100,after:${JSON.stringify(cursor)}){
      ${pageInfo} nodes{id content{... on Issue{id repository{nameWithOwner}}}
      fieldValues(first:100){${pageInfo} nodes{
        ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{name}}}
        ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2Field{id name}}}
      }}}}}}}`).organization.projectV2.items;
    items.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  cursor = null;
  const issues = [];
  do {
    const connection = graphql(`{repository(owner:"grasdouble",name:"Jarvis"){issues(first:100,after:${JSON.stringify(cursor)}){
      ${pageInfo} nodes{id number title url state stateReason createdAt milestone{title}
        labels(first:100){${pageInfo} nodes{name}}
        blockedBy(first:100){${pageInfo} nodes{id}}
        subIssues(first:100){${pageInfo} nodes{id}}
      }}}}`).repository.issues;
    issues.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  const relevant = items.filter(x => x.content?.repository?.nameWithOwner === 'grasdouble/Jarvis');
  const memberships = new Map(relevant.map(item => [item.content.id, item]));
  const normalized = issues.map(issue => {
    const values = memberships.has(issue.id) ? complete(memberships.get(issue.id).fieldValues, 'item fields') : [];
    return { ...issue, milestone: issue.milestone?.title, labels: complete(issue.labels, 'labels').map(x=>x.name),
      blockers: complete(issue.blockedBy, 'blocking dependencies').map(x=>x.id),
      children: complete(issue.subIssues, 'sub-issues').map(x=>x.id),
      status: values.find(x=>x.field?.name === 'Status')?.name ?? null };
  });
  // Require project membership for all open issues, rather than silently omitting work.
  for (const issue of normalized) if (issue.state === 'OPEN' && !memberships.has(issue.id))
    throw new Error(`Open issue #${issue.number} is missing project membership; add it before refresh.`);
  return { projectId: project.id, fieldId: field.id, issues: normalized, items: relevant };
}
function updates(snapshot) {
  const plan = planQueue(snapshot.issues);
  const ranks = new Map(plan.map(x => [x.number, x.rank]));
  const byId = new Map(snapshot.issues.map(x=>[x.id,x]));
  const changes = [];
  for (const item of snapshot.items) {
    const number = byId.get(item.content.id)?.number;
    if (number === undefined) throw new Error('Missing project issue data.');
    const desired = ranks.get(number);
    const current = complete(item.fieldValues, 'item fields').find(x=>x.field?.id === snapshot.fieldId)?.number;
    if (current !== desired) changes.push({ itemId:item.id, number, rank:desired });
  }
  return { plan, changes };
}
const initial = load();
const initialResult = updates(initial);
if (write && initialResult.changes.length) {
  const fresh = load();
  if (JSON.stringify(fresh) !== JSON.stringify(initial)) throw new Error('Project changed during planning; reread before retrying.');
  const { plan, changes } = updates(fresh);
  const shared = `projectId:${JSON.stringify(fresh.projectId)},fieldId:${JSON.stringify(fresh.fieldId)}`;
  // Small sequential batches allow deterministic reconciliation after a partial failure.
  for (let offset=0; offset<changes.length; offset+=20) {
    const batch=changes.slice(offset,offset+20);
    const mutations=batch.map((x,index)=> x.rank === undefined
      ? `m${index}:clearProjectV2ItemFieldValue(input:{${shared},itemId:${JSON.stringify(x.itemId)}}){projectV2Item{id}}`
      : `m${index}:updateProjectV2ItemFieldValue(input:{${shared},itemId:${JSON.stringify(x.itemId)},value:{number:${x.rank}}}){projectV2Item{id}}`);
    graphql(`mutation{${mutations.join('\n')}}`,true);
  }
  if (updates(load()).changes.length) throw new Error('Queue changed or write verification failed; inspect before refreshing again.');
  console.log(JSON.stringify({ mode:'updated', changes:changes.length, plan },null,2));
} else {
  console.log(JSON.stringify({ mode:write ? 'unchanged' : 'preview', changes:initialResult.changes.length, plan:initialResult.plan },null,2));
}
