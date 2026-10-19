import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function getAffectedPackages({ workspaces, changedFiles }) {
  const packageByPath = new Map(
    workspaces
      .filter(({ name, path }) => name && path && normalizePath(path) !== '.')
      .map(({ name, path }) => [normalizePath(path), name]),
  );
  const affected = new Set();

  for (const changedFile of changedFiles) {
    const file = normalizePath(changedFile);
    const packagePath = file.endsWith('/package.json')
      ? file.slice(0, -'/package.json'.length)
      : file.endsWith('/action.yml')
        ? file.slice(0, -'/action.yml'.length)
        : null;
    if (!packagePath) continue;
    const name = packageByPath.get(packagePath);
    if (name) affected.add(name);
  }

  return [...affected].sort();
}

export function buildChangeset(packages) {
  return [
    '---',
    ...[...new Set(packages)].sort().map((name) => `${JSON.stringify(name)}: patch`),
    '---',
    '',
    'Dependency updates',
    '',
  ].join('\n');
}

function isGeneratedChangeset(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return false;
  const end = lines.indexOf('---', 1);
  if (end < 0 || lines.slice(end + 1).join('\n').trim() !== 'Dependency updates') return false;

  const packages = [];
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^((?:"(?:\\.|[^"\\])*")): patch$/);
    if (!match) return false;
    try {
      const name = JSON.parse(match[1]);
      if (typeof name !== 'string' || !name) return false;
      packages.push(name);
    } catch {
      return false;
    }
  }
  return packages.length > 0 && buildChangeset(packages) === content;
}

export function inspectChangesetCandidate({ changedFiles, workspaces, prNumber, candidateRoot }) {
  if (!/^[1-9]\d*$/.test(String(prNumber))) throw new Error('Pull request number must be positive.');
  const root = realpathSync(candidateRoot);
  const affectedPackages = getAffectedPackages({ changedFiles, workspaces });

  if (affectedPackages.length === 0) return { affectedPackages, changesetFile: '' };

  const changesetDirectory = resolve(root, '.changeset');
  const directoryStat = lstatSync(changesetDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !isWithin(root, realpathSync(changesetDirectory))) {
    throw new Error('The Changesets directory must be a real directory inside the checkout.');
  }

  const legacyFiles = changedFiles.filter((path) => /^\.changeset\/dependabot-\d+\.md$/.test(path));
  if (legacyFiles.some((path) => lstatIfPresent(resolve(root, path)) !== null)) {
    throw new Error('Changed legacy Dependabot Changesets are refused to preserve human-authored entries.');
  }

  const changesetFile = `.changeset/dependabot-pr-${prNumber}.md`;
  const changesetPath = resolve(root, changesetFile);
  const changesetStat = lstatIfPresent(changesetPath);
  if (changesetStat) {
    const stat = changesetStat;
    if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(root, realpathSync(changesetPath))) {
      throw new Error('The reserved Dependabot Changeset path must be a regular file in the checkout.');
    }
    if (!isGeneratedChangeset(readFileSync(changesetPath, 'utf8'))) {
      throw new Error('The reserved Dependabot Changeset is not generated content; refusing to overwrite it.');
    }
  }

  return { affectedPackages, changesetFile };
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `dependabot_preflight_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function main() {
  const baseSha = process.env.BASE_SHA ?? '';
  const headSha = process.env.HEAD_SHA ?? '';
  const prNumber = process.env.DEPENDABOT_CHANGESET_PR_NUMBER ?? '';
  const candidateRoot = process.env.GITHUB_WORKSPACE ?? '';
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha) || !candidateRoot) {
    throw new Error('Trusted base/head SHAs and candidate checkout are required.');
  }

  const changedFiles = execFileSync('git', ['diff', '--name-only', '-z', `${baseSha}...${headSha}`], {
    cwd: candidateRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const rawWorkspaces = execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
    cwd: candidateRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const root = realpathSync(candidateRoot);
  const workspaces = JSON.parse(rawWorkspaces)
    .filter(({ name, path }) => name && path)
    .map(({ name, path }) => {
      const absolutePath = realpathSync(isAbsolute(path) ? path : resolve(root, path));
      if (!isWithin(root, absolutePath)) throw new Error('A workspace path resolves outside the candidate checkout.');
      return { name, path: normalizePath(relative(root, absolutePath)) || '.' };
    });

  const result = inspectChangesetCandidate({ changedFiles, workspaces, prNumber, candidateRoot });
  const affected = result.affectedPackages.length > 0;
  writeOutput('affected', String(affected));
  if (affected) {
    console.log(`Changeset required for ${result.affectedPackages.join(', ')}.`);
  } else {
    console.log('No workspace package manifest or action metadata changed; no Changeset or write token is needed.');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
