#!/usr/bin/env node
// Local development authentication only; never distribute this into review sandboxes.
import { createHash, createSign, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const APP = Object.freeze({
  id: 5338438,
  clientId: 'Iv23lizUGCTbekJqlXGm',
  slug: 'jarvis-development-grasdouble',
  installationId: 171906128,
  repository: 'grasdouble/Jarvis',
});

export const NETWORK_EXIT_CODE = 75;
export const NETWORK_RECOVERY = 'JARVIS_GITHUB_NETWORK: GitHub transport failed (possible restricted network, DNS, proxy, TLS or timeout). '
  + 'Check the current execution context and request approved network access to api.github.com when required, '
  + 'then run the reviewed helper with --check-network. Do not change identities or rotate keys based on this error. '
  + 'Do not blindly repeat a write; reconcile remote state before resuming missing authorized effects.';
const transportCodes = new Set(['EPERM', 'EACCES', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const transientTransportCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED',
  'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
function transportCode(error) {
  for (let item = error, depth = 0; item && depth < 4; item = item.cause, depth++) {
    if (transportCodes.has(item.code)) return item.code;
    if (item.name === 'TimeoutError' || item.name === 'AbortError') return 'ETIMEDOUT';
  }
  return null;
}
function transportError(error) {
  const code = transportCode(error);
  // Never retain/print the original cause, headers, body, URL or credential.
  return Object.assign(new Error(NETWORK_RECOVERY + (code ? ` Transport code: ${code}.` : '')),
    {networkFailure: true, retryable: transientTransportCodes.has(code), exitCode: NETWORK_EXIT_CODE});
}
async function githubFetch(url, options) {
  try { return await fetch(url, options); }
  catch (error) { throw transportError(error); }
}
async function retryTransport(operation, eligible) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (eligible && error.retryable && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

const readOnlyGhCommands = new Set(['issue list', 'issue view', 'label list', 'pr list', 'pr view', 'pr checks',
  'project list', 'project view', 'project item-list', 'repo list', 'repo view', 'run list', 'run view',
  'workflow list', 'workflow view']);
const ambiguousReadOnlyGhFlags = new Set(['--web', '--edit', '--watch']);
function retryableGh(args) {
  return args.length >= 2 && readOnlyGhCommands.has(`${args[0]} ${args[1]}`) &&
    !args.slice(2).some(argument => ambiguousReadOnlyGhFlags.has(argument.split('=', 1)[0]));
}
function transientGhFailure(result) {
  const code = result.error?.code;
  if (code && transientTransportCodes.has(code)) return true;
  // gh's diagnostics are variable; accept only known transport phrases, never generic failures.
  return /(?:connection reset|connection refused|no such host|temporary failure in name resolution|i\/o timeout|operation timed out|tls handshake timeout|network is unreachable|context deadline exceeded)/i
    .test(result.stderr ?? '');
}
async function runReadOnlyGh(args, environment) {
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync('gh', args, {encoding: 'utf8', env: environment});
    if (result.status === 0 || attempt >= 2 || !transientGhFailure(result)) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.status ?? 1;
    }
    await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
  }
}
// Only the reviewed helper's distinct exit and fixed marker trigger recovery.
export function appNetworkError(error) {
  if (error.status !== NETWORK_EXIT_CODE || !/(?:^|\n)JARVIS_GITHUB_NETWORK:/.test(String(error.stderr ?? ''))) return null;
  return Object.assign(new Error(NETWORK_RECOVERY), {networkFailure: true, retryable: false, exitCode: NETWORK_EXIT_CODE});
}
async function checkNetwork() {
  const response = await retryTransport(() => githubFetch('https://api.github.com/', {method: 'HEAD', redirect: 'error',
    signal: AbortSignal.timeout(5000), headers: {'User-Agent': APP.slug}}), true);
  // Even an HTTP denial proves transport reachability, never App authorization.
  console.log(JSON.stringify({host: 'api.github.com', network: 'reachable', httpStatus: response.status, authenticated: false}));
  return 0;
}

export function permissions(write = false) {
  return {
    actions: 'read', checks: 'read', metadata: 'read',
    contents: write ? 'write' : 'read', issues: write ? 'write' : 'read',
    pull_requests: write ? 'write' : 'read', workflows: write ? 'write' : undefined,
    organization_projects: write ? 'write' : 'read',
  };
}

export function jwt(privateKey, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({iat: now - 60, exp: now + 540, iss: APP.clientId})}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

export async function loadKey(explicitPath = process.env.JARVIS_GITHUB_APP_KEY_FILE) {
  const folder = path.join(homedir(), 'Library', 'Application Support', 'Jarvis Development', 'credentials');
  let keyPath = explicitPath;
  if (!keyPath) {
    const entries = (await readdir(folder)).filter(name => name.endsWith('.pem'));
    if (entries.length !== 1) throw new Error('Keep exactly one PEM in the credentials folder or set JARVIS_GITHUB_APP_KEY_FILE.');
    keyPath = path.join(folder, entries[0]);
  }
  keyPath = path.resolve(keyPath);
  const directory = await lstat(path.dirname(keyPath));
  const file = await lstat(keyPath);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) ||
      !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) ||
      (uid !== undefined && (file.uid !== uid || directory.uid !== uid))) {
    throw new Error('Use an owner-only credentials directory (700) and a regular owner-only key file (600), without symlinks.');
  }
  return readFile(keyPath);
}

async function api(resource, token, method = 'GET', body, retryRead = true) {
  return retryTransport(async () => {
    const response = await githubFetch(`https://api.github.com${resource}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': APP.slug,
        ...(body ? {'Content-Type': 'application/json'} : {}),
      },
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    if (!response.ok) {
      // Do not expose response bodies, request headers, JWTs, or tokens in diagnostics.
      const error = new Error(`GitHub ${method} ${resource}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch (error) {
      if (transportCode(error)) throw transportError(error);
      throw new Error('GitHub returned an invalid JSON response.');
    }
  }, method === 'GET' && retryRead);
}

export function assertGrant(grant, expected) {
  if (typeof grant.token !== 'string' || !grant.token || !grant.expires_at ||
      !Array.isArray(grant.repositories) || grant.repositories.length !== 1 ||
      grant.repositories[0].full_name !== APP.repository) {
    throw new Error('Installation token did not match the expected repository grant.');
  }
  for (const [name, level] of Object.entries(grant.permissions ?? {})) {
    if (expected[name] !== level) throw new Error(`Unexpected token permission: ${name}.`);
  }
  for (const [name, level] of Object.entries(expected)) {
    if (level && grant.permissions?.[name] !== level) throw new Error(`Missing token permission: ${name}.`);
  }
}

export function childEnvironment(token, temporary) {
  const environment = {...process.env};
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'GH_DEBUG', 'GH_HOST', 'GH_REPO', 'GH_CONFIG_DIR', 'NODE_OPTIONS',
    'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_ASKPASS', 'SSH_ASKPASS']) delete environment[name];
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_CONFIG_')) delete environment[name];
  }
  return {...environment, GH_TOKEN: token, GH_HOST: 'github.com', GH_REPO: APP.repository,
    GH_CONFIG_DIR: temporary, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0'};
}

export function parseArguments(input) {
  const args = [...input];
  if (args[0] === '--dispatch-runtime-integration') {
    if (args.length !== 3 || !/^[1-9][0-9]*$/.test(args[1]) || !Number.isSafeInteger(Number(args[1])) || !/^[0-9a-f]{40}$/i.test(args[2]))
      throw new Error('Usage: --dispatch-runtime-integration OPEN_PR_NUMBER EXPECTED_40_CHARACTER_HEAD_SHA');
    return {write:false, mode:'runtime-dispatch', pullRequest:Number(args[1]), expectedHeadSha:args[2].toLowerCase()};
  }
  const write = args[0] === '--write';
  if (write) args.shift();
  if (!write && args.length === 1 && args[0] === '--check-network') return {write: false, mode: 'network'};
  if (!write && args.length === 1 && args[0] === '--roadmap-query') return {write: false, mode: 'roadmap-query'};
  if (!write && args.length === 1 && args[0] === '--refresh-main') return {write: false, mode: 'refresh-main'};
  if (args.length === 1 && args[0] === '--verify') return {write, mode: 'verify'};
  if (args.length === 1 && args[0] === '--git-push' && write) return {write, mode: 'push'};
  if (args.shift() !== '--' || !['api', 'issue', 'label', 'pr', 'project', 'repo', 'run', 'workflow'].includes(args[0])) {
    throw new Error('Usage: node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs [--write] -- <gh arguments>; --verify; --roadmap-query; or --write --git-push. Authentication/config/extension commands are not exposed.');
  }
  return {write, mode: 'gh', args};
}

const roadmapQueryShapes = {
  RoadmapItems: {variables:['after'], signature:'e30e787d1f3d8247d029313b9d6912de2c61f72dc28448a6653acbb9ecd50e94'},
  RoadmapIssue: {variables:['itemId','number'], signature:'60f86840cab0b4a7c983cc7f988718e00e1988509c125fefd3baa974d0ea8bfb'},
  RoadmapHistory: {variables:['after','number'], signature:'6636cfafdca07000baeb7b2844b8af4671494c4dc4f906d2cd3376d70a5c91c8'},
};
function roadmapQuerySignature(query) {
  return createHash('sha256').update(JSON.stringify(graphqlTokens(query).map(token => [token.kind, token.value ?? null]))).digest('hex');
}
function graphqlTokens(source) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s|,/.test(char) || char === '\uFEFF') { i++; continue; }
    if (char === '#') { while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++; continue; }
    if (source.startsWith('"""', i)) {
      i += 3;
      while (i < source.length && !source.startsWith('"""', i)) {
        if (source.startsWith('\\"""', i)) i += 4; else i++;
      }
      if (i >= source.length) throw new Error('Malformed Roadmap GraphQL query.');
      i += 3; tokens.push({kind: 'string', value: null}); continue;
    }
    if (char === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error('Malformed Roadmap GraphQL query.');
      tokens.push({kind: 'string', value: JSON.parse(source.slice(start, i))}); continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (name) { tokens.push({kind: 'name', value: name[0]}); i += name[0].length; continue; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
    if (number) { tokens.push({kind: 'number', value:number[0]}); i += number[0].length; continue; }
    if (source.startsWith('...', i)) { tokens.push({kind: 'punct', value: '...'}); i += 3; continue; }
    if ('!$():=@[]{|}&'.includes(char)) { tokens.push({kind: 'punct', value: char}); i++; continue; }
    throw new Error('Malformed Roadmap GraphQL query.');
  }
  return tokens;
}
function rejectDuplicateJsonKeys(source) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? '')) index++; };
  function string() {
    const start = index++;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index++] === '"') return JSON.parse(source.slice(start, index));
    }
    throw new Error('Malformed JSON input.');
  }
  function value() {
    whitespace();
    if (source[index] === '"') { string(); return; }
    if (source[index] === '{') {
      index++; whitespace(); const keys = new Set();
      if (source[index] === '}') { index++; return; }
      while (index < source.length) {
        whitespace();
        if (source[index] !== '"') throw new Error('Malformed JSON input.');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate JSON property.');
        keys.add(key); whitespace();
        if (source[index++] !== ':') throw new Error('Malformed JSON input.');
        value(); whitespace();
        if (source[index] === '}') { index++; return; }
        if (source[index++] !== ',') throw new Error('Malformed JSON input.');
      }
      throw new Error('Malformed JSON input.');
    }
    if (source[index] === '[') {
      index++; whitespace();
      if (source[index] === ']') { index++; return; }
      while (index < source.length) {
        value(); whitespace();
        if (source[index] === ']') { index++; return; }
        if (source[index++] !== ',') throw new Error('Malformed JSON input.');
      }
      throw new Error('Malformed JSON input.');
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index++;
    if (index === 0) throw new Error('Malformed JSON input.');
  }
  value(); whitespace();
  if (index !== source.length) throw new Error('Malformed JSON input.');
}

export function isRoadmapQuery(body) {
  try { validateRoadmapQuery(body); return true; }
  catch { return false; }
}

function validateRoadmapQuery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'query,variables' || typeof body.query !== 'string' ||
      !body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables)) {
    throw new Error('Malformed Roadmap query input.');
  }
  const tokens = graphqlTokens(body.query);
  if (tokens[0]?.kind !== 'name' || tokens[0].value !== 'query' ||
      tokens[1]?.kind !== 'name' || !roadmapQueryShapes[tokens[1].value] ||
      tokens[2]?.kind !== 'punct' || !['(', '{'].includes(tokens[2].value)) {
    throw new Error('Unrecognized Roadmap GraphQL query.');
  }
  const shape = roadmapQueryShapes[tokens[1].value];
  if (Object.keys(body.variables).sort().join(',') !== shape.variables.join(',') ||
      roadmapQuerySignature(body.query) !== shape.signature) {
    throw new Error('Roadmap GraphQL query does not match its recognized read shape.');
  }
  if ('after' in body.variables && body.variables.after !== null && typeof body.variables.after !== 'string') {
    throw new Error('Invalid Roadmap cursor variable.');
  }
  if ('number' in body.variables && (!Number.isSafeInteger(body.variables.number) || body.variables.number < 1)) {
    throw new Error('Invalid Roadmap issue variable.');
  }
  if ('itemId' in body.variables && (typeof body.variables.itemId !== 'string' || !body.variables.itemId)) {
    throw new Error('Invalid Roadmap item variable.');
  }
  let braces = 0, parentheses = 0, brackets = 0, rootClosed = false, sawRoot = false;
  for (const token of tokens.slice(2)) {
    if (rootClosed) throw new Error('Multiple or trailing Roadmap GraphQL operations are not allowed.');
    if (token.kind !== 'punct') continue;
    if (token.value === '(') parentheses++;
    else if (token.value === ')') { if (--parentheses < 0) throw new Error('Malformed Roadmap GraphQL query.'); }
    else if (token.value === '[') brackets++;
    else if (token.value === ']') { if (--brackets < 0) throw new Error('Malformed Roadmap GraphQL query.'); }
    else if (token.value === '{') {
      if (parentheses === 0 && brackets === 0) sawRoot = true;
      braces++;
    } else if (token.value === '}') {
      if (--braces < 0) throw new Error('Malformed Roadmap GraphQL query.');
      if (sawRoot && braces === 0 && parentheses === 0 && brackets === 0) rootClosed = true;
    }
  }
  if (!sawRoot || !rootClosed || braces || parentheses || brackets) throw new Error('Malformed Roadmap GraphQL query.');
  return body;
}

async function runRoadmapQuery() {
  let body;
  try {
    const input = readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error('Roadmap query input is too large.');
    rejectDuplicateJsonKeys(input);
    body = validateRoadmapQuery(JSON.parse(input));
  }
  catch { throw new Error('Invalid or unrecognized Roadmap query input.'); }
  const signed = jwt(await loadKey());
  const identity = await api('/app', signed, 'GET', undefined, false);
  if (identity.id !== APP.id || identity.slug !== APP.slug) throw new Error('Private key belongs to another GitHub App.');
  const expected = permissions(false);
  const grant = await api(`/app/installations/${APP.installationId}/access_tokens`, signed, 'POST', {
    repositories: [APP.repository.split('/')[1]], permissions: expected,
  });
  try {
    assertGrant(grant, expected);
    const result = await retryTransport(() => api('/graphql', grant.token, 'POST', body), true);
    console.log(JSON.stringify(result));
    return 0;
  } finally {
    try { await api('/installation/token', grant.token, 'DELETE'); }
    catch { console.error('Could not confirm token revocation; the issued token expires automatically within one hour.'); }
  }
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {encoding: 'utf8', ...options});
  if (result.status !== 0) throw new Error('Git operation failed; inspect the local branch and worktree.');
  return result.stdout.trim();
}

export async function refreshMain({target, commonGitDir, git: runGit, fetchMain, cleanupMain, fastForward, tempRef = () => `refs/jarvis/main-refresh/${randomUUID()}`}) {
  if (!/^[0-9a-f]{40}$/i.test(target ?? '')) return {status:'skipped', reason:'GitHub main ref did not contain a valid commit SHA.'};
  const primary = path.dirname(commonGitDir);
  const worktrees = (await runGit(['worktree', 'list', '--porcelain'])).split('\n\n');
  const main = worktrees.find(entry => entry.split('\n').includes(`worktree ${primary}`));
  if (!main || !main.split('\n').includes('branch refs/heads/main')) return {status:'skipped', reason:'Primary repository worktree is not on local main.'};
  if (await runGit(['-C', primary, 'status', '--porcelain'])) return {status:'skipped', reason:'Primary main worktree is not clean.'};
  const ref = tempRef();
  let fetched, fetchError;
  try { fetched = await fetchMain(primary, ref); }
  catch { fetchError = true; }
  try { await cleanupMain(primary, ref); }
  catch { return {status:'skipped', reason:'Temporary fetch ref cleanup failed; inspect local refs before continuing.'}; }
  if (fetchError) return {status:'skipped', reason:'App-authenticated fetch failed.'};
  if (fetched.toLowerCase() !== target.toLowerCase()) return {status:'skipped', reason:'Fetched main SHA does not match GitHub API target.'};
  if (!(await runGit(['-C', primary, 'merge-base', '--is-ancestor', 'HEAD', target], {allowFailure:true})))
    return {status:'skipped', reason:'Local main cannot fast-forward to GitHub main.'};
  if (await runGit(['-C', primary, 'status', '--porcelain'])) return {status:'skipped', reason:'Primary main worktree became dirty.'};
  if (!(await fastForward(primary, target))) return {status:'skipped', reason:'Fast-forward update failed.'};
  return {status:'updated', sha:target};
}

async function run(options) {
  if (options.mode === 'network') return checkNetwork();
  if (options.mode === 'roadmap-query') return runRoadmapQuery();
  const signed = jwt(await loadKey());
  const identity = await api('/app', signed, 'GET', undefined, false);
  if (identity.id !== APP.id || identity.slug !== APP.slug) throw new Error('Private key belongs to another GitHub App.');
  const expected = options.mode === 'runtime-dispatch'
    ? {actions:'write', metadata:'read', pull_requests:'read'} : permissions(options.write);
  const grant = await api(`/app/installations/${APP.installationId}/access_tokens`, signed, 'POST', {
    repositories: [APP.repository.split('/')[1]], permissions: expected,
  });
  let temporary;
  try {
    assertGrant(grant, expected);
    if (options.mode === 'runtime-dispatch') {
      const pr = await api(`/repos/${APP.repository}/pulls/${options.pullRequest}`, grant.token);
      if (pr.state !== 'open' || pr.head?.sha?.toLowerCase() !== options.expectedHeadSha)
        throw new Error('Pull request is not open at the expected head SHA; no workflow was dispatched.');
      const dispatch = await api(`/repos/${APP.repository}/actions/workflows/on-demand-runtime-integration.yml/dispatches`, grant.token, 'POST', {
        ref:'main', inputs:{pull_request:String(options.pullRequest), expected_head_sha:options.expectedHeadSha},
      }, false);
      const runId = dispatch?.workflow_run_id;
      const runUrl = `https://api.github.com/repos/${APP.repository}/actions/runs/${runId}`;
      const htmlUrl = `https://github.com/${APP.repository}/actions/runs/${runId}`;
      if (!Number.isSafeInteger(runId) || runId < 1 || dispatch.run_url !== runUrl || dispatch.html_url !== htmlUrl)
        throw new Error('Workflow dispatch response did not provide valid run metadata; run outcome is unknown. Reconcile Actions state before any retry.');
      console.log(JSON.stringify({dispatched:true, workflow:'on-demand-runtime-integration.yml', ref:'main', pullRequest:options.pullRequest,
        expectedHeadSha:options.expectedHeadSha, runId, runUrl:htmlUrl}));
      return 0;
    }
    if (options.mode === 'verify') {
      const repository = await api(`/repos/${APP.repository}`, grant.token);
      const installation = await api('/installation/repositories', grant.token);
      if (repository.full_name !== APP.repository || installation.total_count !== 1) throw new Error('Unexpected repository access.');
      let administrationDenied = false;
      try { await api(`/repos/${APP.repository}/actions/permissions`, grant.token); }
      catch (error) { if (error.status === 403) administrationDenied = true; else throw error; }
      if (!administrationDenied) throw new Error('Expected repository Administration access to be denied.');
      console.log(`Verified ${APP.slug}: ${APP.repository} only; Administration denied; ${options.write ? 'write' : 'read'} profile. Token expires ${grant.expires_at}; revoked on exit.`);
      return 0;
    }
    temporary = await mkdtemp(path.join(tmpdir(), 'jarvis-gh-'));
    const environment = childEnvironment(grant.token, temporary);
    if (options.mode === 'refresh-main') {
      try {
        const response = await api(`/repos/${APP.repository}/git/ref/heads/main`, grant.token);
        const target = response.object?.sha;
        const commonGitDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const askpass = path.join(temporary, 'askpass.sh');
        await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$GH_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', {mode: 0o700});
        const gitEnvironment = {...environment, HOME: temporary, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: askpass};
        const remote = `https://github.com/${APP.repository}.git`;
        const result = await refreshMain({target, commonGitDir,
          git: async (args, {allowFailure = false} = {}) => {
            const child = spawnSync('git', args, {encoding:'utf8', ...(args[0] === '-C' ? {env:gitEnvironment} : {})});
            if (child.status !== 0 && !allowFailure) throw new Error('Git operation failed.');
            return allowFailure ? child.status === 0 : child.stdout.trim();
          },
          fetchMain: async (directory, ref) => {
            const root = path.dirname(commonGitDir);
            if (await (async()=>{const out=spawnSync('git',['-C',root,'ls-remote','--get-url',remote],{encoding:'utf8',env:gitEnvironment});return out.status===0&&out.stdout.trim()===remote;})() !== true)
              throw new Error('Git configuration rewrites the HTTPS destination.');
            const fetched = spawnSync('git', ['-C', directory, '-c', 'credential.helper=', 'fetch', '--no-write-fetch-head', '--no-tags', remote, `refs/heads/main:${ref}`], {encoding:'utf8', env:gitEnvironment});
            if (fetched.status !== 0) throw new Error('App-authenticated fetch failed.');
            return spawnSync('git', ['-C', directory, 'rev-parse', ref], {encoding:'utf8', env:gitEnvironment}).stdout.trim();
          },
          cleanupMain: async (_directory, ref) => {
            const cleanup = spawnSync('git', ['-C', path.dirname(commonGitDir), 'update-ref', '-d', ref], {encoding:'utf8', env:gitEnvironment});
            if (cleanup.status !== 0) throw new Error('Temporary ref cleanup failed.');
          },
          fastForward: async (directory, sha) => spawnSync('git', ['-C', directory, 'merge', '--ff-only', sha], {stdio:'ignore', env:gitEnvironment}).status === 0});
        console.log(JSON.stringify({mainRefresh:result.status, ...(result.sha ? {sha:result.sha} : {}), ...(result.reason ? {reason:result.reason} : {})}));
      } catch (error) {
        console.log(JSON.stringify({mainRefresh:'skipped', reason:error.message.startsWith('Skip') ? error.message.slice(6) : error.message}));
        return 0;
      }
      return 0;
    }
    if (options.mode === 'push') {
      const repository = await api(`/repos/${APP.repository}`, grant.token);
      const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
      git(['check-ref-format', '--branch', branch]);
      if (branch === repository.default_branch) throw new Error('Push an issue branch; direct default-branch pushes are not supported.');
      const askpass = path.join(temporary, 'askpass.sh');
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$GH_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', {mode: 0o700});
      const pushEnvironment = {...environment, HOME: temporary, XDG_CONFIG_HOME: temporary,
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: askpass};
      const remote = `https://github.com/${APP.repository}.git`;
      if (git(['ls-remote', '--get-url', remote], {env: pushEnvironment}) !== remote) {
        throw new Error('Repository Git configuration rewrites the HTTPS push destination.');
      }
      // Empty credential.helper resets configured helpers; neither URL nor arguments contain a token.
      const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'credential.username=x-access-token', 'push',
        remote, `HEAD:refs/heads/${branch}`], {
        stdio: 'inherit', env: pushEnvironment,
      });
      return result.status ?? 1;
    }
    if (!options.write && retryableGh(options.args)) return runReadOnlyGh(options.args, environment);
    const result = spawnSync('gh', options.args, {stdio: 'inherit', env: environment});
    return result.status ?? 1;
  } finally {
    try { await api('/installation/token', grant.token, 'DELETE'); }
    catch { console.error('Could not confirm token revocation; the issued token expires automatically within one hour.'); }
    if (temporary) await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await run(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = error.networkFailure ? NETWORK_EXIT_CODE : 1; }
}
