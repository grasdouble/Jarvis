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

function describeChanges(updates) {
  return updates.map(update=>{
    const changes={};
    if(update.addToProject)changes.projectMembership={before:false,after:true};
    if(update.milestone)changes.milestone={...update.milestone};
    if(update.issue)changes.issue={...update.issue};
    return {number:update.number,projectItemId:update.itemId,source:update.source,changes};
  });
}

function isSameEffect(update,effect) {
  return update!==undefined&&JSON.stringify(nextEffect(update))===JSON.stringify(effect);
}

function noProgressDiagnostic(effect,update,failure) {
  let observed,expected;
  if(effect.kind==='add'){
    observed={projectMembership:false};expected={projectMembership:true};
  } else if(effect.kind==='milestone'){
    observed={milestone:update.milestone.before};expected={milestone:update.milestone.after};
  } else {
    observed={issue:update.issue.before};expected={issue:update.issue.after};
  }
  return {number:update.number,code:'no_progress',severity:'error',effect:effect.kind,
    source:update.source,observed,expected,
    outcome:failure?(failure.safeToRetry?'confirmed_not_applied':
      failure.retryable===true||failure.ambiguous===true?'ambiguous':'permanent_failure'): 'no_error_response'};
}

/** Reconcile every uncertain write before retrying; source relationships remain authoritative. */
export async function synchronizeMetadata({load,apply,write=false,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const initial=await load();
  const planned=planMetadata(initial);
  const result={mode:write?'unchanged':'preview',attemptedWrites:0,verifiedPRs:0,
    pending:planned.updates.length,pendingChanges:describeChanges(planned.updates),diagnostics:planned.diagnostics};
  if (!write || !planned.updates.length) return result;
  const noProgress=new Map();
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
      // Always reconcile a possibly applied effect before deciding whether another mutation is safe.
      update=await current();
      if (failure?.networkFailure) throw failure;
      if (failure&&failure.retryable!==true) {
        if (isSameEffect(update,effect)) {
          noProgress.set(original.number,noProgressDiagnostic(effect,update,failure));
          break;
        }
        throw new Error(`Metadata write failed for PR #${original.number} after observable progress.`);
      }
      if (isSameEffect(update,effect)) {
        // A successful or ambiguous write may be hidden by a stale read. Give read-after-write
        // propagation one bounded chance; never resend the same effect merely because it is stale.
        await pause(250);
        const confirmed=await current();
        if (!isSameEffect(confirmed,effect)) {
          update=confirmed;
          continue;
        }
        if (failure?.safeToRetry===true) {
          if (++failures>=3) {
            noProgress.set(original.number,noProgressDiagnostic(effect,confirmed,failure));
            update=confirmed;
            break;
          }
          await pause(250*failures);
          update=confirmed;
          continue;
        }
        noProgress.set(original.number,noProgressDiagnostic(effect,confirmed,failure));
        update=confirmed;
        break;
      }
      if (failure) {
        // The desired value is already visible, or a different next effect proves progress.
        failures=0;
      }
    }
  }
  const final=planMetadata(await load());
  result.pending=final.updates.length;
  result.pendingChanges=describeChanges(final.updates);
  const finalPendingNumbers=new Set(final.updates.map(update=>update.number));
  const finalErrorNumbers=new Set(final.diagnostics.filter(diagnostic=>diagnostic.severity==='error')
    .map(diagnostic=>diagnostic.number));
  result.verifiedPRs=planned.updates.filter(update=>!finalPendingNumbers.has(update.number)&&
    !finalErrorNumbers.has(update.number)).length;
  result.diagnostics=[...final.diagnostics];
  for(const update of final.updates){
    const previous=noProgress.get(update.number);
    const effect=nextEffect(update);
    if(previous?.effect===effect.kind){
      const failure=previous.outcome==='confirmed_not_applied'?{safeToRetry:true}:
        previous.outcome==='ambiguous'?{retryable:true}:
        previous.outcome==='permanent_failure'?{retryable:false}:undefined;
      result.diagnostics.push(noProgressDiagnostic(effect,update,failure));
    } else {
      const diagnostic=noProgressDiagnostic(effect,update);
      diagnostic.code='pending_changes';
      delete diagnostic.outcome;
      result.diagnostics.push(diagnostic);
    }
  }
  result.mode=result.pending?'incomplete':'synchronized';
  return result;
}
