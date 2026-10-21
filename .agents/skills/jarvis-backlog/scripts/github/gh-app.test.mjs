import { generateKeyPairSync, createVerify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP, assertGrant, childEnvironment, jwt, loadKey, parseArguments, permissions, refreshMain } from './gh-app.mjs';

test('JWT has the expected identity, RS256 signature, and bounded validity', () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const parts = jwt(privateKey, 1000000).split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(claims.iss, APP.clientId);
  assert.equal(claims.iat, 999940);
  assert.ok(claims.exp <= 1000600);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(parts.slice(0, 2).join('.'));
  assert.ok(verifier.verify(publicKey, Buffer.from(parts[2], 'base64url')));
});

test('read profile requests no write or administration rights', () => {
  assert.ok(Object.values(permissions()).filter(Boolean).every(value => value === 'read'));
  assert.equal(permissions().administration, undefined);
  assert.equal(permissions().workflows, undefined);
  assert.equal(permissions(true).contents, 'write');
  assert.equal(permissions(true).administration, undefined);
});

function grant(overrides = {}) {
  return {token: 'synthetic-test-value', expires_at: '2099-01-01T00:00:00Z',
    repositories: [{full_name: APP.repository}],
    permissions: Object.fromEntries(Object.entries(permissions()).filter(([, value]) => value)), ...overrides};
}

test('grant accepts exact permissions without assuming a token format', () => {
  assert.doesNotThrow(() => assertGrant(grant(), permissions()));
});

test('grant rejects other repositories, expanded rights, and missing rights', () => {
  assert.throws(() => assertGrant(grant({repositories: [{full_name: 'other/repo'}]}), permissions()));
  assert.throws(() => assertGrant(grant({permissions: {...grant().permissions, administration: 'write'}}), permissions()));
  assert.throws(() => assertGrant(grant({repositories: [...grant().repositories, {full_name: 'other/repo'}]}), permissions()));
  assert.throws(() => assertGrant(grant({permissions: {metadata: 'read'}}), permissions()));
});

test('Git push requires explicit write mode; credential and extension commands are rejected', () => {
  assert.equal(parseArguments(['--', 'pr', 'list']).write, false);
  assert.equal(parseArguments(['--write', '--git-push']).mode, 'push');
  assert.throws(() => parseArguments(['--git-push']));
  assert.throws(() => parseArguments(['--', 'auth', 'token']));
  assert.throws(() => parseArguments(['--', 'extension', 'exec', 'untrusted']));
});

const primary = '/repo';
const primaryCommon = '/repo/.git';
const targetSha = 'a'.repeat(40);
function fakeGit({worktree = `worktree ${primary}\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/main`, dirty = '', ancestor = true} = {}) {
  return async args => {
    if (args[0] === 'worktree') return worktree;
    if (args[2] === 'status') return dirty;
    if (args[2] === 'merge-base') return ancestor;
    throw new Error(`Unexpected synthetic git command: ${args.join(' ')}`);
  };
}
test('main refresh fast-forwards only a clean primary main to the exact API SHA', async () => {
  let fetched = 0, merged = 0, cleaned = 0;
  const result = await refreshMain({target:targetSha, commonGitDir:primaryCommon, git:fakeGit(),
    fetchMain:async(_path, ref)=>{fetched++; assert.match(ref,/^refs\/jarvis\/main-refresh\//); return targetSha;},
    cleanupMain:async()=>{cleaned++;}, fastForward:async(_path, sha)=>{merged++; return sha===targetSha;}});
  assert.deepEqual(result, {status:'updated', sha:targetSha});
  assert.equal(fetched, 1); assert.equal(merged, 1); assert.equal(cleaned,1);
});
test('main refresh skips when main is absent or exists only in a linked worktree', async () => {
  for (const worktree of ['', `worktree /repo/linked\nbranch refs/heads/main`]) {
    let fetched = false;
    const result = await refreshMain({target:targetSha, commonGitDir:primaryCommon, git:fakeGit({worktree}),
      fetchMain:async()=>{fetched=true;return targetSha;}, cleanupMain:async()=>{}, fastForward:async()=>true});
    assert.equal(result.status, 'skipped'); assert.equal(fetched, false);
  }
});
test('main refresh skips dirty worktree, SHA mismatch, non-fast-forward and fetch failure without merging', async () => {
  const cases = [
    {git:fakeGit({dirty:' M tracked'}), fetchMain:async()=>targetSha, cleanupExpected:0},
    {git:fakeGit(), fetchMain:async()=> 'c'.repeat(40), cleanupExpected:1},
    {git:fakeGit({ancestor:false}), fetchMain:async()=>targetSha, cleanupExpected:1},
    {git:fakeGit(), fetchMain:async()=>{throw new Error('synthetic fetch failure');}, cleanupExpected:1},
  ];
  for (const item of cases) {
    let merged = false, cleaned = 0;
    const result=await refreshMain({target:targetSha,commonGitDir:primaryCommon,...item,
      cleanupMain:async()=>{cleaned++;}, fastForward:async()=>{merged=true;return true;}});
    assert.equal(result.status,'skipped');
    assert.equal(merged,false);
    assert.equal(cleaned,item.cleanupExpected);
  }
});

test('child environment replaces personal credentials and removes trace/config injection', () => {
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_DEBUG', 'GIT_TRACE_CURL', 'GIT_CONFIG_COUNT'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'ambient-test-value';
    const environment = childEnvironment('new-test-value', '/temporary-gh-config');
    assert.equal(environment.GH_TOKEN, 'new-test-value');
    assert.equal(environment.GH_CONFIG_DIR, '/temporary-gh-config');
    for (const name of names.slice(1)) assert.equal(environment[name], undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('key loading rejects shared permissions and symlink files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jarvis-key-test-'));
  const file = path.join(directory, 'key.pem');
  try {
    await writeFile(file, 'synthetic fixture, not a real key', {mode: 0o600});
    assert.equal((await loadKey(file)).toString(), 'synthetic fixture, not a real key');
    await chmod(file, 0o644);
    await assert.rejects(loadKey(file), /owner-only/);
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await assert.rejects(loadKey(file), /owner-only/);
    await chmod(directory, 0o700);
    const link = path.join(directory, 'linked.pem');
    await symlink(file, link);
    await assert.rejects(loadKey(link), /owner-only/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// Full CLI fixtures intercept every request and use a synthetic key only.
async function fixtureCommand(t, args, behavior, {key = true, ghExit} = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'jarvis-network-test-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const keyPath = path.join(folder, 'fixture.pem');
  if (key) {
    const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
    await writeFile(keyPath, privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600});
  }
  const calls = path.join(folder, 'calls.jsonl');
  const preload = path.join(folder, 'fetch-fixture.mjs');
  await writeFile(preload, `import {appendFileSync} from 'node:fs';
    globalThis.fetch = async (url, options = {}) => {
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url, method: options.method ?? 'GET'}) + '\\n');
      ${behavior}
    };`);
  if (ghExit !== undefined) await writeFile(path.join(folder, 'gh'), `#!/bin/sh\nexit ${ghExit}\n`, {mode: 0o700});
  const result = spawnSync(process.execPath,
    ['--import', preload, fileURLToPath(new URL('./gh-app.mjs', import.meta.url)), ...args], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: {PATH: `${folder}:${process.env.PATH}`, HOME: folder, TMPDIR: folder,
        JARVIS_GITHUB_APP_KEY_FILE: keyPath},
    });
  assert.equal(result.error, undefined);
  let requests = [];
  try { requests = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {...result, requests};
}

test('network probe needs no key and sends no credentials, body or write request', async t => {
  const r = await fixtureCommand(t, ['--check-network'], `
    if (url !== 'https://api.github.com/' || options.method !== 'HEAD' || options.body ||
        Object.keys(options.headers ?? {}).some(name => name.toLowerCase() === 'authorization'))
      throw new Error('Unexpected credential or request');
    return new Response(null, {status: 200});`, {key: false});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {host: 'api.github.com', network: 'reachable', httpStatus: 200, authenticated: false});
  assert.equal(r.requests.length, 1);
});

test('public probe reports HTTP reachability without claiming App authentication', async t => {
  const r = await fixtureCommand(t, ['--check-network'], 'return new Response(null, {status: 403});', {key: false});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).httpStatus, 403);
  assert.equal(JSON.parse(r.stdout).authenticated, false);
});

test('transport failures have a stable recovery exit and never expose raw causes', async t => {
  for (const code of ['EPERM', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT', 'synthetic-secret']) {
    const r = await fixtureCommand(t, ['--verify'], `throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('synthetic-secret headers/key/token'), {code: ${JSON.stringify(code)}})});`);
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /JARVIS_GITHUB_NETWORK:/);
    assert.match(r.stderr, /--check-network/);
    assert.match(r.stderr, /approved network/i);
    assert.doesNotMatch(r.stderr, /synthetic-secret|headers\/key\/token/);
    assert.equal(r.requests.length, 1, 'no blind transport retry');
  }
});

test('network probe timeout is bounded and classified without using App credentials', async t => {
  const r = await fixtureCommand(t, ['--check-network'], `
    if (!options.signal || options.signal.aborted) throw new Error('Missing live deadline');
    throw new DOMException('synthetic-secret timeout details', 'TimeoutError');`, {key: false});
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /JARVIS_GITHUB_NETWORK:/);
  assert.doesNotMatch(r.stderr, /synthetic-secret/);
});

test('HTTP auth errors and malformed JSON are not network-permission diagnoses', async t => {
  for (const status of [401, 403]) {
    const auth = await fixtureCommand(t, ['--verify'], `return new Response('synthetic-secret', {status: ${status}});`);
    assert.equal(auth.status, 1);
    assert.match(auth.stderr, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(auth.stderr, /JARVIS_GITHUB_NETWORK:|synthetic-secret/);
  }
  const invalid = await fixtureCommand(t, ['--verify'], "return new Response('synthetic-secret', {status: 200});");
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /JARVIS_GITHUB_NETWORK:|synthetic-secret/);
});

test('lost token-grant response stops without replaying POST or dispatching a write', async t => {
  const r = await fixtureCommand(t, ['--write', '--', 'issue', 'create'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    throw new TypeError('fetch failed', {cause: {code: 'ECONNRESET'}});`);
  assert.equal(r.status, 75, r.stderr);
  assert.deepEqual(r.requests.map(x => x.method), ['GET', 'POST']);
  assert.match(r.stderr, /reconcile/i);
});

test('downstream pending-check exit is preserved and the grant is revoked once', async t => {
  const data = JSON.stringify(grant());
  const r = await fixtureCommand(t, ['--', 'pr', 'checks', '1'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    return Response.json(${data});`, {ghExit: 8});
  assert.equal(r.status, 8, r.stderr);
  assert.doesNotMatch(r.stderr, /JARVIS_GITHUB_NETWORK:/);
  assert.deepEqual(r.requests.map(x => x.method), ['GET', 'POST', 'DELETE']);
});
