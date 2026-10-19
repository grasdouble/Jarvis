import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

export function mapWorkspaceList(workspaces, trustedRoot, candidateRoot) {
  if (!Array.isArray(workspaces)) throw new Error('PNPM returned an invalid workspace package list.');
  const trusted = resolve(trustedRoot);
  const candidate = resolve(candidateRoot);

  return workspaces.map((workspace) => {
    if (!workspace || typeof workspace.path !== 'string' || !workspace.path) return workspace;
    const trustedPath = resolve(trusted, workspace.path);
    if (!isWithin(trusted, trustedPath)) {
      throw new Error('A trusted workspace resolved outside the trusted base checkout.');
    }
    const relativePath = relative(trusted, trustedPath);
    return { ...workspace, path: resolve(candidate, relativePath) };
  });
}

function main() {
  const expectedArgs = ['-r', 'list', '--depth', '-1', '--json'];
  if (process.argv.slice(2).join('\0') !== expectedArgs.join('\0')) {
    throw new Error('Only the pinned workspace-list command is permitted.');
  }

  const trustedRoot = process.env.JARVIS_TRUSTED_BASE;
  const candidateRoot = process.env.GITHUB_WORKSPACE;
  const pnpm = process.env.JARVIS_REAL_PNPM;
  if (!trustedRoot || !candidateRoot || !pnpm || !isAbsolute(pnpm)) {
    throw new Error('Trusted workspace-list configuration is incomplete.');
  }

  const result = spawnSync(pnpm, expectedArgs, {
    cwd: trustedRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Pinned PNPM workspace discovery exited with status ${result.status}.`);
  }

  const workspaces = mapWorkspaceList(JSON.parse(result.stdout), trustedRoot, candidateRoot);
  process.stdout.write(JSON.stringify(workspaces));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
