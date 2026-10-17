import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOptions,assertCiContext,requestError} from './sync-pr-project-metadata.mjs';
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
  const e=requestError({stderr:'HTTP 503 synthetic-secret'});assert.equal(e.retryable,true);assert.ok(!e.message.includes('synthetic-secret'));
  assert.equal(requestError({stderr:'HTTP 403 synthetic-secret'}).retryable,false);
});
