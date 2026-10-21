import { setTimeout } from 'node:timers/promises';
import { planQueue } from './project-queue.mjs';
import { appNetworkError } from './gh-app.mjs';

export function queueUpdates(snapshot) {
  const plan = planQueue(snapshot.issues);
  const ranks = new Map(plan.map(x => [x.number, x.rank]));
  const byId = new Map(snapshot.issues.map(x=>[x.id,x]));
  const changes = [];
  for (const item of snapshot.items) {
    const number = byId.get(item.content.id)?.number;
    if (number === undefined) throw new Error('Missing project issue data.');
    const desired = ranks.get(number);
    if (!item.fieldValues || item.fieldValues.pageInfo.hasNextPage) throw new Error('Incomplete item fields.');
    const current = item.fieldValues.nodes.find(x=>x.field?.id === snapshot.fieldId)?.number;
    if (current !== desired) changes.push({ itemId:item.id, number, rank:desired });
  }
  return { plan, changes };
}

// Compare all planning inputs and membership, allowing only our attempted rank writes.
function reconcile(initial, current, attempted) {
  const remaining = queueUpdates(current);
  const context = snapshot => ({ ...snapshot, items:snapshot.items.map(item => ({ ...item,
    fieldValues:{ pageInfo:{hasNextPage:item.fieldValues.pageInfo.hasNextPage}, nodes:item.fieldValues.nodes.filter(x=>x.field?.id !== snapshot.fieldId) } })) });
  if (JSON.stringify(context(initial)) !== JSON.stringify(context(current)))
    throw new Error('Project planning inputs changed; partial progress retained. Reread before refreshing again.');
  const ranks = snapshot => new Map(snapshot.items.map(item => [item.id,
    item.fieldValues.nodes.find(x=>x.field?.id === snapshot.fieldId)?.number]));
  const before = ranks(initial);
  for (const [id, value] of ranks(current)) {
    if (value !== before.get(id) && (!attempted.has(id) || value !== attempted.get(id)))
      throw new Error('Unexpected rank edit; partial progress retained. Inspect before refreshing again.');
  }
  return remaining;
}

// Fail closed on unknown, permission, validation and rate-limit errors. No raw diagnostics in errors.
export function queueRequestError(error) {
  const network = appNetworkError(error);
  if (network) return network;
  let errors;
  try { errors = JSON.parse(String(error.stdout ?? '')).errors; } catch { /* Non-JSON transport failure. */ }
  const transient = text => !/\bHTTP (?:400|401|403|404|409|422|429)\b|rate.?limit|forbidden|bad credentials|validation failed/i.test(text) && /\bHTTP (?:500|502|503|504)\b|\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b|TLS handshake timeout|context deadline exceeded|couldn't respond to your request in time|request timed out/i.test(text);
  const retryable = errors?.length
    ? errors.every(x=>transient(x.message ?? ''))
    : transient(String(error.stderr ?? error.message ?? ''));
  return Object.assign(new Error('GitHub queue request failed; inspect project state before a manual retry.'), {retryable});
}

export async function synchronizeQueue({ load, writeBatch, write = false, wait = setTimeout }) {
  const initial = await load();
  const initialResult = queueUpdates(initial);
  if (!write || !initialResult.changes.length)
    return { mode:write ? 'unchanged' : 'preview', changes:initialResult.changes.length, plan:initialResult.plan };
  const fresh = await load();
  if (JSON.stringify(fresh) !== JSON.stringify(initial)) throw new Error('Project changed during planning; reread before retrying.');
  let pending = initialResult.changes;
  let batchSize = 5;
  let recoveries = 0;
  let sent = false;
  const attempted = new Map();
  while (pending.length) {
    // GitHub recommends at least one second between mutative requests; never parallelize.
    if (sent) await wait(1000);
    sent = true;
    const batch = pending.slice(0,batchSize);
    for (const change of batch) attempted.set(change.itemId,change.rank);
    let failure;
    try { await writeBatch(fresh,batch); }
    catch (error) { failure=error; }
    if (!failure) pending=pending.slice(batch.length);
    if (failure || !pending.length) {
      // An ambiguous response can hide partial or complete success. Never replay the batch blindly.
      if (failure?.retryable) await wait(1000 * 2 ** recoveries);
      const remaining = reconcile(initial,await load(),attempted);
      if (failure?.networkFailure) throw failure;
      if (failure && !failure.retryable)
        throw new Error('Non-retryable queue write failure; state reread, partial progress retained. Inspect before retrying.');
      if (!remaining.changes.length)
        return { mode:'updated', changes:initialResult.changes.length, plan:remaining.plan };
      if (recoveries === 3)
        throw new Error('Queue recovery budget exhausted; partial progress retained. Inspect before refreshing again.');
      recoveries++;
      if (!failure) await wait(1000 * 2 ** (recoveries-1));
      batchSize=Math.max(1,Math.floor(batchSize/2));
      pending=remaining.changes;
    }
  }
}
