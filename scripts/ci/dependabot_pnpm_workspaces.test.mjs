import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mapWorkspaceList } from './dependabot_pnpm_workspaces.mjs';

const script = fileURLToPath(new URL('./dependabot_pnpm_workspaces.mjs', import.meta.url));

test('maps trusted package paths into the candidate checkout and preserves the root package', () => {
  const trusted = path.join(os.tmpdir(), 'jarvis-trusted-base');
  const candidate = path.join(os.tmpdir(), 'jarvis-candidate');
  const workspaces = mapWorkspaceList([
    { name: 'jarvis', path: trusted },
    { name: '@jarvis/domain', path: path.join(trusted, 'packages/domain') },
  ], trusted, candidate);

  assert.equal(workspaces[0].path, candidate);
  assert.equal(workspaces[1].path, path.join(candidate, 'packages/domain'));
});

test('rejects a workspace path outside the trusted base', () => {
  assert.throws(
    () => mapWorkspaceList([{ name: 'outside', path: path.join(os.tmpdir(), 'other') }], '/trusted', '/candidate'),
    /outside the trusted base checkout/,
  );
});

test('runs pinned PNPM from the trusted base instead of the candidate repository', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'jarvis-dependabot-pnpm-'));
  const trusted = path.join(temporary, 'trusted');
  const candidate = path.join(temporary, 'candidate');
  const packagePath = path.join(trusted, 'packages/domain');
  const realPnpm = path.join(temporary, 'pnpm');
  const cwdLog = path.join(temporary, 'pnpm-cwd');
  const marker = path.join(temporary, 'candidate-config-executed');
  const node = process.execPath;

  try {
    mkdirSync(packagePath, { recursive: true });
    mkdirSync(path.join(candidate, 'packages/domain'), { recursive: true });
    writeFileSync(path.join(candidate, '.pnpmfile.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`);
    writeFileSync(
      realPnpm,
      `#!/bin/sh\npwd > "$PNPM_CWD_LOG"\nprintf '%s' '[{"name":"@jarvis/domain","path":${JSON.stringify(packagePath)}}]'\n`,
      { mode: 0o700 },
    );
    process.env.PNPM_CWD_LOG = cwdLog;
    const result = spawnSync(node, [script, '-r', 'list', '--depth', '-1', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JARVIS_REAL_PNPM: realPnpm,
        JARVIS_TRUSTED_BASE: trusted,
        GITHUB_WORKSPACE: candidate,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { name: '@jarvis/domain', path: path.join(candidate, 'packages/domain') },
    ]);
    assert.equal(readFileSync(cwdLog, 'utf8').trim(), realpathSync(trusted));
    assert.equal(requireExists(marker), false);
  } finally {
    delete process.env.PNPM_CWD_LOG;
    rmSync(temporary, { recursive: true, force: true });
  }
});

function requireExists(pathname) {
  try {
    readFileSync(pathname);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
