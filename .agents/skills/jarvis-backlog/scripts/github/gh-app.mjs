#!/usr/bin/env node
// Local development authentication only; never distribute this into review sandboxes.
import { createSign } from 'node:crypto';
import { lstat, readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
    {networkFailure: true, exitCode: NETWORK_EXIT_CODE});
}
async function githubFetch(url, options) {
  try { return await fetch(url, options); }
  catch (error) { throw transportError(error); }
}
// Only the reviewed helper's distinct exit and fixed marker trigger recovery.
export function appNetworkError(error) {
  if (error.status !== NETWORK_EXIT_CODE || !/(?:^|\n)JARVIS_GITHUB_NETWORK:/.test(String(error.stderr ?? ''))) return null;
  return Object.assign(new Error(NETWORK_RECOVERY), {networkFailure: true, retryable: false, exitCode: NETWORK_EXIT_CODE});
}
async function checkNetwork() {
  const response = await githubFetch('https://api.github.com/', {method: 'HEAD', redirect: 'error',
    signal: AbortSignal.timeout(5000), headers: {'User-Agent': APP.slug}});
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

async function api(resource, token, method = 'GET', body) {
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
  const write = args[0] === '--write';
  if (write) args.shift();
  if (!write && args.length === 1 && args[0] === '--check-network') return {write: false, mode: 'network'};
  if (args.length === 1 && args[0] === '--verify') return {write, mode: 'verify'};
  if (args.length === 1 && args[0] === '--git-push' && write) return {write, mode: 'push'};
  if (args.shift() !== '--' || !['api', 'issue', 'label', 'pr', 'project', 'repo', 'run', 'workflow'].includes(args[0])) {
    throw new Error('Usage: node .agents/skills/jarvis-backlog/scripts/github/gh-app.mjs [--write] -- <gh arguments>; --verify; or --write --git-push. Authentication/config/extension commands are not exposed.');
  }
  return {write, mode: 'gh', args};
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {encoding: 'utf8', ...options});
  if (result.status !== 0) throw new Error('Git operation failed; inspect the local branch and worktree.');
  return result.stdout.trim();
}

async function run(options) {
  if (options.mode === 'network') return checkNetwork();
  const signed = jwt(await loadKey());
  const identity = await api('/app', signed);
  if (identity.id !== APP.id || identity.slug !== APP.slug) throw new Error('Private key belongs to another GitHub App.');
  const expected = permissions(options.write);
  const grant = await api(`/app/installations/${APP.installationId}/access_tokens`, signed, 'POST', {
    repositories: [APP.repository.split('/')[1]], permissions: expected,
  });
  let temporary;
  try {
    assertGrant(grant, expected);
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
