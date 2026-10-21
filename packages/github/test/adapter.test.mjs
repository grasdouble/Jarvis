import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubAdapter } from '../src/index.ts';

const identity = { taskId: 'task-1', revision: 'abc', repository: 'acme/app', head: 'jarvis/task-1', base: 'main', title: 'Task change' };
const marker = `JARVIS task ${identity.taskId} at revision ${identity.revision}`;
const pr = { number: 7, state: 'open', title: identity.title, body: marker, head: { ref: identity.head, label: `acme:${identity.head}`, sha: identity.revision }, base: { ref: identity.base, sha: 'def' }, merged: false };
const response = (body, status = 200, headers = {}) => new globalThis.Response(JSON.stringify(body), { status, headers });
function setup(fetch, authorized = async () => true) {
  let authorizationChecks = 0;
  const tokenScopes = [];
  const adapter = createGitHubAdapter({ authorizeProjectRepository: async (repo) => repo === 'acme/app' && authorized(), authorizeInstallationRepository: async (repo) => { authorizationChecks++; return repo === 'acme/app' && authorized(); }, token: async (repo, permission) => { tokenScopes.push([repo, permission]); return 'synthetic'; }, fetch });
  return { adapter, authorizationChecks: () => authorizationChecks, tokenScopes };
}

test('creates PR and reports confirmed only after a valid successful response', async () => {
  const calls = [];
  const { adapter } = setup(async (url, init) => { calls.push([url, init]); return response(pr, 201); });
  assert.deepEqual(await adapter.publishPullRequest(identity), { outcome: 'confirmed', pullRequest: { number: 7, state: 'open', headSha: 'abc', baseSha: 'def', merged: false } });
  assert.equal(calls[0][1].method, 'POST');
});

test('does not confirm successful POST whose branch head SHA differs from requested revision', async () => {
  const wrongSha = { ...pr, head: { ...pr.head, sha: 'different-revision' } };
  const { adapter } = setup(async (_url, init) => init.method === 'POST' ? response(wrongSha, 201) : response([]));
  assert.equal((await adapter.publishPullRequest(identity)).outcome, 'unknown');
});

test('requests repository-bound least permission tokens for reads and writes', async () => {
  const { adapter, tokenScopes } = setup(async (_url, init) => init.method === 'GET' ? response({ ...pr, merged: false }) : response(pr, 201));
  await adapter.getPullRequest('acme/app', 7);
  await adapter.publishPullRequest(identity);
  assert.deepEqual(tokenScopes, [['acme/app', 'pull-requests:read'], ['acme/app', 'pull-requests:write']]);
});

test('rechecks current internal allowlist and denies effects after repository removal', async () => {
  let allowed = true;
  let effects = 0;
  const { adapter } = setup(async () => { effects++; return response(pr); }, async () => allowed);
  await adapter.getPullRequest('acme/app', 7);
  allowed = false;
  await assert.rejects(adapter.getPullRequest('acme/app', 7), /not authorized/);
  assert.equal(effects, 1);
});

test('reconciliation uses owner:head filter and fetches full PR details after list match', async () => {
  const calls = [];
  const { adapter } = setup(async (url) => {
    calls.push(url);
    if (url.includes('/pulls?')) return response([{ ...pr, merged: undefined }]);
    return response(pr);
  });
  assert.equal((await adapter.reconcilePublication(identity)).outcome, 'found');
  assert.match(calls[0], /head=acme%3Ajarvis%2Ftask-1/);
  assert.match(calls[1], /\/pulls\/7$/);
});

test('rejects denied writes and checks current installation authorization before each effect', async () => {
  let allowed = true;
  let effects = 0;
  const { adapter } = setup(async () => { effects++; return response({}, 403); }, async () => allowed);
  assert.deepEqual(await adapter.publishPullRequest(identity), { outcome: 'rejected', reason: 'forbidden' });
  allowed = false;
  await assert.rejects(adapter.getPullRequest('acme/app', 7), /not authorized/);
  assert.equal(effects, 1);
});

test('lost response reconciles an exact matching PR and confirms it', async () => {
  let calls = 0;
  const { adapter } = setup(async (url) => { calls++; if (calls === 1) throw new TypeError('connection lost'); return url.includes('/pulls?') ? response([pr]) : response(pr); });
  assert.equal((await adapter.publishPullRequest(identity)).outcome, 'confirmed');
  assert.equal(calls, 3);
});

test('same refs and title from another task revision stay unknown after lost response', async () => {
  const otherTask = { ...pr, body: 'JARVIS task task-elsewhere at revision old-revision' };
  const { adapter } = setup(async (url, init) => {
    if (init.method === 'POST') throw new TypeError('response lost');
    if (url.includes('/pulls?')) return response([otherTask]);
    return response(otherTask);
  });
  assert.deepEqual(await adapter.publishPullRequest(identity), { outcome: 'unknown', reason: 'identity-mismatch' });
});

test('lost response with no match remains unknown and does not retry POST', async () => {
  let posts = 0;
  const { adapter } = setup(async (_url, init) => { if (init.method === 'POST') { posts++; throw new TypeError('timeout'); } return response([]); });
  assert.deepEqual(await adapter.publishPullRequest(identity), { outcome: 'unknown', reason: 'not-found' });
  assert.equal(posts, 1);
});

test('public reconciliation models complete no-match as unknown, not not-found', async () => {
  const { adapter } = setup(async () => response([]));
  assert.deepEqual(await adapter.reconcilePublication(identity), { outcome: 'unknown', reason: 'not-found' });
});

test('unreadable or incomplete paginated reconciliation remains unknown', async () => {
  for (const listResponse of [new globalThis.Response('', { status: 500 }), response([], 200, { Link: '<https://api.github.com/repos/acme/app/pulls?page=2>; rel="next"' })]) {
    let posts = 0;
    let reads = 0;
    const { adapter } = setup(async (_url, init) => { if (init.method === 'POST') { posts++; throw new TypeError('timeout'); } reads++; return listResponse; });
    assert.equal((await adapter.publishPullRequest(identity)).outcome, 'unknown');
    assert.equal(posts, 1);
    assert.equal(reads, 1);
  }
});

test('unauthorized scope produces no API effects', async () => {
  let effects = 0;
  const { adapter } = setup(async () => { effects++; return response(pr, 201); }, async () => false);
  await assert.rejects(adapter.publishPullRequest(identity), /not authorized/);
  assert.equal(effects, 0);
});
