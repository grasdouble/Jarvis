#!/usr/bin/env node
/** Trusted contributor tooling; never executes code from issues or analyzed repositories. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { synchronizeQueue, queueRequestError } from './project-queue-sync.mjs';
import { NETWORK_EXIT_CODE } from './gh-app.mjs';

const args = process.argv.slice(2);
if (args.some(x => x !== '--write')) throw new Error('Usage: node .agents/skills/jarvis-project-management/scripts/github/sync-project-queue.mjs [--write]');
const write = args.includes('--write');
const helper = fileURLToPath(new URL('./gh-app.mjs', import.meta.url));
function gh(values, mutate = false) {
  return JSON.parse(execFileSync(process.execPath, [helper, ...(mutate ? ['--write'] : []), '--', ...values],
    { encoding: 'utf8', stdio:['ignore','pipe','pipe'], maxBuffer: 32 * 1024 * 1024 }));
}
function graphql(query, mutate = false) {
  try {
    const result = gh(['api', 'graphql', '-f', `query=${query}`], mutate);
    if (result.errors?.length) throw { stdout:JSON.stringify({errors:result.errors}) };
    return result.data;
  } catch (error) { throw queueRequestError(error); }
}
function complete(connection, name) {
  if (!connection || connection.pageInfo.hasNextPage) throw new Error(`Incomplete ${name}; refresh stopped. Inspect any partial progress.`);
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
function writeBatch(snapshot,batch) {
  const shared = `projectId:${JSON.stringify(snapshot.projectId)},fieldId:${JSON.stringify(snapshot.fieldId)}`;
  const mutations=batch.map((x,index)=> x.rank === undefined
    ? `m${index}:clearProjectV2ItemFieldValue(input:{${shared},itemId:${JSON.stringify(x.itemId)}}){projectV2Item{id}}`
    : `m${index}:updateProjectV2ItemFieldValue(input:{${shared},itemId:${JSON.stringify(x.itemId)},value:{number:${x.rank}}}){projectV2Item{id}}`);
  graphql(`mutation{${mutations.join('\n')}}`,true);
}
try {
  console.log(JSON.stringify(await synchronizeQueue({load,writeBatch,write}),null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode=error.networkFailure?NETWORK_EXIT_CODE:1;
}
