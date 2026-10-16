import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP, assertGrant, childEnvironment, jwt, loadKey, parseArguments, permissions } from './gh-app.mjs';

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
