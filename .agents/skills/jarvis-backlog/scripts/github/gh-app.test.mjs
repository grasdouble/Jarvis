import { generateKeyPairSync, createVerify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP, assertGrant, childEnvironment, jwt, loadKey, parseArguments, permissions, refreshMain } from './gh-app.mjs';
import { createRoadmapApi } from './roadmap-dates-sync.mjs';
import { ROADMAP_CONFIG as ROADMAP } from './roadmap-dates.mjs';

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
async function roadmapInput(name, variables) {
  const page=(nodes,next=false,cursor=null)=>({nodes,pageInfo:{hasNextPage:next,endCursor:cursor}});
  const fields=page([{id:ROADMAP.startFieldId,name:ROADMAP.startFieldName,dataType:'DATE'},
    {id:ROADMAP.completionFieldId,name:ROADMAP.completionFieldName,dataType:'DATE'}]);
  const issue={id:'I_test',number:190,repository:{nameWithOwner:ROADMAP.repository},state:'OPEN',stateReason:null,closedAt:null,
    timelineItems:page([],name==='RoadmapHistory','history-cursor')};
  const item={id:'ITEM_test',project:{id:ROADMAP.projectId},start:null,completion:null,status:null,
    content:{__typename:'Issue',...issue}};
  const queries=[];
  const api=async request=>{
    queries.push(request.body.query);
    if(request.body.query.includes('query RoadmapItems'))
      return {data:{organization:{projectV2:{id:ROADMAP.projectId,fields,items:page([item])}}}};
    if(request.body.query.includes('query RoadmapHistory'))
      return {data:{repository:{issue:{timelineItems:page([])}}}};
    if(request.body.query.includes('query RoadmapIssue'))
      return {data:{organization:{projectV2:{id:ROADMAP.projectId,fields}},node:item,
        repository:{issue:{...issue,timelineItems:page([])}}}};
    throw new Error('Unexpected fixture query.');
  };
  const roadmap=createRoadmapApi({api});
  await roadmap.load();
  if(name==='RoadmapIssue')await roadmap.load(issue.number);
  const query=queries.find(candidate=>candidate.includes(`query ${name}`));
  assert.ok(query,`production Roadmap query ${name} was emitted`);
  return JSON.stringify({query,variables});
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
  assert.deepEqual(parseArguments(['--roadmap-query']), {write:false, mode:'roadmap-query'});
  assert.equal(parseArguments(['--write', '--git-push']).mode, 'push');
  assert.throws(() => parseArguments(['--git-push']));
  assert.throws(() => parseArguments(['--write', '--roadmap-query']));
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
async function fixtureCommand(t, args, behavior, {key = true, ghExit, ghScript, input} = {}) {
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
  if (ghScript !== undefined) await writeFile(path.join(folder, 'gh'), `#!/bin/sh\n${ghScript.replaceAll('__COUNT__', path.join(folder, 'gh-count'))}\n`, {mode: 0o700});
  else if (ghExit !== undefined) await writeFile(path.join(folder, 'gh'), `#!/bin/sh\nexit ${ghExit}\n`, {mode: 0o700});
  const result = spawnSync(process.execPath,
    ['--import', preload, fileURLToPath(new URL('./gh-app.mjs', import.meta.url)), ...args], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: {PATH: `${folder}:${process.env.PATH}`, HOME: folder, TMPDIR: folder,
        JARVIS_GITHUB_APP_KEY_FILE: keyPath},
      ...(input === undefined ? {} : {input}),
    });
  assert.equal(result.error, undefined);
  let requests = [];
  try { requests = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let ghCalls = 0;
  try { ghCalls = Number(await readFile(path.join(folder, 'gh-count'), 'utf8')); } catch {}
  return {...result, requests, ghCalls};
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

test('network probe retries classified transient transport failures at most twice', async t => {
  const r = await fixtureCommand(t, ['--check-network'], `
    const n = globalThis.__attempts = (globalThis.__attempts ?? 0) + 1;
    if (n < 3) throw new TypeError('fetch failed', {cause: {code: 'ECONNRESET'}});
    return new Response(null, {status: 200});`, {key: false});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.requests.length, 3);
  assert.equal(JSON.parse(r.stdout).authenticated, false);
});

test('network probe stops after three transient failures without leaking causes', async t => {
  const r = await fixtureCommand(t, ['--check-network'], `
    throw new TypeError('fetch failed synthetic-secret', {cause: {code: 'ECONNRESET'}});`, {key: false});
  assert.equal(r.status, 75);
  assert.equal(r.requests.length, 3);
  assert.doesNotMatch(r.stderr, /synthetic-secret/);
});

test('read response-body transport failures retry the individual GET only', async t => {
  const r = await fixtureCommand(t, ['--verify'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (options.method === 'POST') return Response.json(${JSON.stringify(grant())});
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    if (url.endsWith('/repos/${APP.repository}') && !url.endsWith('/actions/permissions')) {
      globalThis.__repoReads = (globalThis.__repoReads ?? 0) + 1;
      if (globalThis.__repoReads === 1) return new Response(new ReadableStream({start(controller) {
        controller.error(new TypeError('synthetic-secret', {cause: {code: 'ECONNRESET'}}));
      }}), {status: 200});
      return Response.json({full_name: ${JSON.stringify(APP.repository)}});
    }
    if (url.endsWith('/installation/repositories')) return Response.json({total_count: 1});
    return new Response(null, {status: 403});`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.requests.filter(x => x.url.endsWith(`/repos/${APP.repository}`)).length, 2);
  assert.equal(r.requests.filter(x => x.method === 'POST').length, 1);
  assert.doesNotMatch(r.stderr, /synthetic-secret/);
});

test('public probe reports HTTP reachability without claiming App authentication', async t => {
  const r = await fixtureCommand(t, ['--check-network'], 'return new Response(null, {status: 403});', {key: false});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).httpStatus, 403);
  assert.equal(JSON.parse(r.stdout).authenticated, false);
});

test('transport failures have a stable recovery exit and never expose raw causes', async t => {
  for (const code of ['EPERM', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT', 'synthetic-secret']) {
    const r = await fixtureCommand(t, ['--verify'], `
      if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      if (url.endsWith('/access_tokens')) return Response.json(${JSON.stringify(grant())});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('synthetic-secret headers/key/token'), {code: ${JSON.stringify(code)}})});`);
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /JARVIS_GITHUB_NETWORK:/);
    assert.match(r.stderr, /--check-network/);
    assert.match(r.stderr, /approved network/i);
    assert.doesNotMatch(r.stderr, /synthetic-secret|headers\/key\/token/);
    assert.equal(r.requests.filter(request => request.url.endsWith(`/repos/${APP.repository}`)).length,
      ['ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ? 3 : 1,
      'only classified transient GET transport failures retry');
    assert.equal(r.requests.filter(request => request.method === 'POST').length, 1, 'token mint is never retried');
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
    const auth = await fixtureCommand(t, ['--verify'], `
      if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      if (options.method === 'POST') return Response.json(${JSON.stringify(grant())});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      return new Response('synthetic-secret', {status: ${status}});`);
    assert.equal(auth.status, 1);
    assert.equal(auth.requests.filter(x => x.url.endsWith(`/repos/${APP.repository}`)).length, 1);
    assert.match(auth.stderr, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(auth.stderr, /JARVIS_GITHUB_NETWORK:|synthetic-secret/);
  }
  const invalid = await fixtureCommand(t, ['--verify'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (options.method === 'POST') return Response.json(${JSON.stringify(grant())});
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    return new Response('synthetic-secret', {status: 200});`);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.requests.filter(x => x.url.endsWith(`/repos/${APP.repository}`)).length, 1);
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

test('recognized read-only gh forms retry transient child failures; writes and unknown forms do not', async t => {
  for (const [args, expected] of [
    [['--', 'pr', 'checks', '1'], 3],
    [['--', 'pr', 'checks', '1', '--watch'], 1],
    [['--', 'issue', 'create'], 1],
    [['--', 'api', '/repos/grasdouble/Jarvis'], 1],
    [['--', 'repo', 'delete', 'grasdouble/Jarvis'], 1],
  ]) {
    const r = await fixtureCommand(t, args, `
      if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      return Response.json(${JSON.stringify(grant())});`, {
      ghScript: `n=0; [ ! -f __COUNT__ ] || n=$(cat __COUNT__); n=$((n+1)); echo $n > __COUNT__; echo 'connection reset' >&2; exit 1`,
    });
    assert.equal(r.status, 1);
    assert.equal(r.ghCalls, expected, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.requests.filter(x => x.method === 'POST').length, 1, 'token mint is not replayed');
  }
});

test('allowlisted read-only gh retries once then succeeds without reminting its token', async t => {
  const r = await fixtureCommand(t, ['--', 'pr', 'checks', '1'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    return Response.json(${JSON.stringify(grant())});`, {
    ghScript: `n=0; [ ! -f __COUNT__ ] || n=$(cat __COUNT__); n=$((n+1)); echo $n > __COUNT__; if [ $n -eq 1 ]; then echo 'connection reset' >&2; exit 1; fi; echo 'checks passed'; exit 0`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.ghCalls, 2);
  assert.match(r.stdout, /checks passed/);
  assert.equal(r.requests.filter(x => x.method === 'POST').length, 1);
});

test('ambiguous equals-form gh flags fail closed without retry', async t => {
  for (const args of [
    ['--', 'issue', 'view', '123', '--web=true'],
    ['--', 'pr', 'checks', '123', '--watch=true'],
  ]) {
    const r = await fixtureCommand(t, args, `
      if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      return Response.json(${JSON.stringify(grant())});`, {
      ghScript: `n=0; [ ! -f __COUNT__ ] || n=$(cat __COUNT__); n=$((n+1)); echo $n > __COUNT__; echo 'connection reset' >&2; exit 1`,
    });
    assert.equal(r.status, 1);
    assert.equal(r.ghCalls, 1, `${args.join(' ')} must not be retried`);
    assert.equal(r.requests.filter(x => x.method === 'POST').length, 1, 'token mint must not replay');
  }
});

test('Roadmap query mode retries only the GraphQL read after one token mint', async t => {
  const r = await fixtureCommand(t, ['--roadmap-query'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (url.endsWith('/access_tokens')) return Response.json(${JSON.stringify(grant())});
    if (url.endsWith('/graphql')) {
      globalThis.__queryAttempts = (globalThis.__queryAttempts ?? 0) + 1;
      if (globalThis.__queryAttempts === 1) throw new TypeError('synthetic-secret', {cause: {code: 'ECONNRESET'}});
      return Response.json({data: {organization: {projectV2: {id: 'synthetic-project'}}}});
    }
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    throw new Error('Unexpected request');`, {
    input: await roadmapInput('RoadmapItems',{after:null}),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {data: {organization: {projectV2: {id: 'synthetic-project'}}}});
  assert.equal(r.requests.filter(request => request.url.endsWith('/access_tokens')).length, 1);
  assert.equal(r.requests.filter(request => request.url.endsWith('/graphql')).length, 2);
});

test('Roadmap query mode exhausts three query attempts without replaying authentication', async t => {
  const r = await fixtureCommand(t, ['--roadmap-query'], `
    if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
    if (url.endsWith('/access_tokens')) return Response.json(${JSON.stringify(grant())});
    if (url.endsWith('/graphql')) throw new TypeError('synthetic-secret', {cause: {code: 'ECONNRESET'}});
    if (options.method === 'DELETE') return new Response(null, {status: 204});
    throw new Error('Unexpected request');`, {
    input: await roadmapInput('RoadmapIssue',{number:190,itemId:'ITEM_test'}),
  });
  assert.equal(r.status, 75);
  assert.match(r.stderr, /JARVIS_GITHUB_NETWORK:/);
  assert.doesNotMatch(r.stderr, /synthetic-secret/);
  assert.equal(r.requests.filter(request => request.url.endsWith('/access_tokens')).length, 1);
  assert.equal(r.requests.filter(request => request.url.endsWith('/graphql')).length, 3);
});

test('Roadmap query mode rejects mutation, unknown, malformed, and ambiguous input before auth', async t => {
  const itemsInput=await roadmapInput('RoadmapItems',{after:null});
  const duplicatedQuery = JSON.stringify(JSON.parse(itemsInput).query);
  for (const input of [
    JSON.stringify({query: 'mutation RoadmapDates{updateProjectV2ItemFieldValue{id}}', variables: {}}),
    JSON.stringify({query: 'query UnknownOperation{viewer{login}}', variables: {}}),
    JSON.stringify({...JSON.parse(itemsInput),query:JSON.parse(itemsInput).query.slice(0,-1)}),
    JSON.stringify({...JSON.parse(itemsInput),query:JSON.parse(itemsInput).query.replace(/}$/, ' viewer { login }}')}),
    JSON.stringify({...JSON.parse(itemsInput),query:`${JSON.parse(itemsInput).query} query RoadmapIssue{viewer{login}}`}),
    `{"query":${duplicatedQuery},"query":${duplicatedQuery},"variables":{"after":null}}`,
  ]) {
    const r = await fixtureCommand(t, ['--roadmap-query'], "throw new Error('Validation must reject before transport');", {input});
    assert.equal(r.status, 1);
    assert.equal(r.requests.length, 0);
    assert.match(r.stderr, /Invalid or unrecognized Roadmap query input/);
  }
});

test('Roadmap query mode never retries App identity or token-mint requests', async t => {
  for (const failAt of ['identity', 'mint']) {
    const r = await fixtureCommand(t, ['--roadmap-query'], `
      if (url.endsWith('/app')) {
        if (${JSON.stringify(failAt)} === 'identity') throw new TypeError('synthetic-secret', {cause: {code: 'ECONNRESET'}});
        return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      }
      if (url.endsWith('/access_tokens')) throw new TypeError('synthetic-secret', {cause: {code: 'ECONNRESET'}});
      throw new Error('Unexpected request');`, {
      input: await roadmapInput('RoadmapHistory',{number:190,after:null}),
    });
    assert.equal(r.status, 75);
    assert.match(r.stderr, /JARVIS_GITHUB_NETWORK:/);
    assert.doesNotMatch(r.stderr, /synthetic-secret/);
    assert.equal(r.requests.filter(request => request.url.endsWith('/app')).length, 1);
    assert.equal(r.requests.filter(request => request.url.endsWith('/access_tokens')).length, failAt === 'mint' ? 1 : 0);
    assert.equal(r.requests.filter(request => request.url.endsWith('/graphql')).length, 0);
  }
});

test('Roadmap GraphQL HTTP errors are never retried', async t => {
  for (const status of [401, 403, 500, 429]) {
    const r = await fixtureCommand(t, ['--roadmap-query'], `
      if (url.endsWith('/app')) return Response.json({id: ${APP.id}, slug: ${JSON.stringify(APP.slug)}});
      if (url.endsWith('/access_tokens')) return Response.json(${JSON.stringify(grant())});
      if (url.endsWith('/graphql')) return new Response('synthetic-secret response body', {status: ${status}});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      throw new Error('Unexpected request');`, {
      input: await roadmapInput('RoadmapHistory',{number:190,after:null}),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(r.stderr, /synthetic-secret/);
    assert.equal(r.requests.filter(request => request.url.endsWith('/access_tokens')).length, 1);
    assert.equal(r.requests.filter(request => request.url.endsWith('/graphql')).length, 1);
  }
});
