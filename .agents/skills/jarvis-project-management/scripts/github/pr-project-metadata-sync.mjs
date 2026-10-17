import { planMetadata } from './pr-project-metadata.mjs';

function source(pr) {
  if (!pr) throw new Error('Pull request disappeared; synchronization stopped.');
  return JSON.stringify({id:pr.id,repository:pr.repository,selfUpdate:pr.labels.includes('self-update'),issues:pr.issues});
}
function nextEffect(update) {
  if (update.addToProject) return {kind:'add',number:update.number,pullRequestId:update.id};
  if (update.milestone) return {kind:'milestone',number:update.number,milestoneNumber:update.milestone.after};
  if (update.issue) return {kind:'issue',number:update.number,itemId:update.itemId,text:update.issue.after};
  throw new Error('Unsupported metadata update.');
}

/** Reconcile every uncertain write before retrying; source relationships remain authoritative. */
export async function synchronizeMetadata({load,apply,write=false,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const initial=await load();
  const planned=planMetadata(initial);
  const result={mode:write?'unchanged':'preview',attemptedWrites:0,verifiedPRs:0,pending:planned.updates.length,diagnostics:planned.diagnostics};
  if (!write || !planned.updates.length) return result;
  for (const original of planned.updates) {
    const expected=source(initial.pullRequests.find(pr=>pr.number===original.number));
    const current=async()=>{
      const snapshot=await load(original.number);
      const plan=planMetadata(snapshot);
      if (source(snapshot.pullRequests.find(pr=>pr.number===original.number))!==expected)
        throw new Error(`Native source changed for PR #${original.number}; synchronization stopped.`);
      return plan.updates.find(update=>update.number===original.number);
    };
    let failures=0,attempts=0,update=await current();
    while (update) {
      if (++attempts>12) throw new Error('Mutation limit exhausted; inspect concurrent metadata changes.');
      const effect=nextEffect(update);
      let failure;
      result.attemptedWrites++;
      try { await apply(effect); } catch (error) { failure=error; }
      // A failed response can still mean the mutation was committed by GitHub.
      update=await current();
      if (failure) {
        if (failure.networkFailure) throw failure;
        if (failure.retryable!==true) throw new Error(`Metadata write failed for PR #${original.number}.`);
        if (++failures>=3) throw new Error('Retry limit exhausted; inspect confirmed partial progress.');
        if (update) await pause(250*failures);
      }
    }
    result.verifiedPRs++;
  }
  const final=planMetadata(await load());
  result.pending=final.updates.length;
  result.diagnostics=final.diagnostics;
  if (result.pending) throw new Error('Metadata changed during synchronization; inspect partial progress and rerun.');
  result.mode='synchronized';
  return result;
}
