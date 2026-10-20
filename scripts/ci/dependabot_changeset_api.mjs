import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY = 'grasdouble/Jarvis';
export const SIGNAL_WORKFLOW_NAME = 'Dependabot changesets signal';
export const SIGNAL_WORKFLOW_PATH = '.github/workflows/dependabot-changesets.yml';
const MAX_PULL_REQUEST_FILES = 3000;
const PAGE_SIZE = 100;
const TIMEOUT_MS = 15_000;

function normalizePath(path) {
  return path.replace(/^\.\//, '').replace(/\/$/, '');
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function isSafeDependabotBranch(branch) {
  if (typeof branch !== 'string' || !branch.startsWith('dependabot/') || branch.length > 250) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('@{')) return false;
  const parts = branch.split('/');
  return parts.length > 1 && parts.every((part) => part && part !== '.' && part !== '..'
    && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

function encodeRefPath(branch) {
  if (!isSafeDependabotBranch(branch)) throw new Error('Dependabot branch is not a safe Git ref.');
  return branch.split('/').map(encodeURIComponent).join('/');
}

function emptyPlan() {
  return { affectedPackages: [], changesetPath: '', content: '', shouldWrite: false };
}

export function getAffectedPackages({ workspaces, changedFiles }) {
  if (!Array.isArray(workspaces) || !Array.isArray(changedFiles)) {
    throw new Error('Workspace metadata and changed paths must be arrays.');
  }

  const packageByPath = new Map(
    workspaces
      .filter((workspace) => workspace && typeof workspace.name === 'string' && workspace.name
        && typeof workspace.path === 'string' && workspace.path && normalizePath(workspace.path) !== '.')
      .map(({ name, path }) => [normalizePath(path), name]),
  );
  const affected = new Set();

  for (const changedFile of changedFiles) {
    if (typeof changedFile !== 'string' || !changedFile || changedFile.startsWith('/') || changedFile.includes('\\')) {
      throw new Error('GitHub returned an invalid changed path.');
    }
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
  if (!Array.isArray(packages) || packages.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('Changeset package names must be non-empty strings.');
  }
  const entries = [...new Set(packages)].sort();
  if (entries.length === 0) throw new Error('A generated Changeset must target at least one package.');
  return [
    '---',
    ...entries.map((name) => `${JSON.stringify(name)}: patch`),
    '---',
    '',
    'Dependency updates',
    '',
  ].join('\n');
}

function parseGeneratedChangeset(content, knownPackages) {
  if (typeof content !== 'string') return null;
  const lines = content.replace(/^\uFEFF/, '').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0 || lines.slice(end + 1).join('\n') !== '\nDependency updates\n') return null;

  const packages = [];
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^("(?:\\.|[^"\\])*"): patch$/);
    if (!match) return null;
    let name;
    try {
      name = JSON.parse(match[1]);
    } catch {
      return null;
    }
    if (typeof name !== 'string' || !knownPackages.has(name)) return null;
    packages.push(name);
  }
  if (packages.length === 0 || buildChangeset(packages) !== content) return null;
  return packages;
}

export function buildChangesetPlan({
  prNumber,
  changedFiles,
  workspaces,
  changesetDirectory,
  changesetEntries = [],
  reservedContent,
}) {
  if (!/^[1-9]\d*$/.test(String(prNumber))) throw new Error('Pull request number must be positive.');
  const affectedPackages = getAffectedPackages({ workspaces, changedFiles });
  if (affectedPackages.length === 0) return emptyPlan();

  if (!changesetDirectory || changesetDirectory.path !== '.changeset'
      || changesetDirectory.type !== 'tree' || changesetDirectory.mode !== '040000') {
    throw new Error('A real .changeset directory is required for an affected package update.');
  }
  if (!Array.isArray(changesetEntries)) throw new Error('GitHub returned an invalid Changesets tree.');

  const entryByPath = new Map();
  for (const entry of changesetEntries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.includes('/')) {
      throw new Error('GitHub returned an invalid Changesets tree entry.');
    }
    if (entryByPath.has(entry.path)) throw new Error('GitHub returned duplicate Changesets tree entries.');
    entryByPath.set(entry.path, entry);
  }

  const changedLegacyPath = changedFiles.some((file) => /^\.changeset\/dependabot-\d+\.md$/.test(file));
  if (changedLegacyPath && [...entryByPath.keys()].some((file) => /^dependabot-\d+\.md$/.test(file))) {
    throw new Error('A changed legacy Dependabot Changeset still exists; refusing to overwrite or delete it.');
  }

  const changesetPath = `.changeset/dependabot-pr-${prNumber}.md`;
  const changesetFilename = changesetPath.slice('.changeset/'.length);
  const existing = entryByPath.get(changesetFilename);
  const desiredContent = buildChangeset(affectedPackages);
  if (existing) {
    if (existing.type !== 'blob' || existing.mode !== '100644' || typeof existing.sha !== 'string') {
      throw new Error('The reserved Dependabot Changeset path must be a regular file.');
    }
    const knownPackages = new Set(workspaces
      .filter(({ path }) => typeof path === 'string' && normalizePath(path) !== '.')
      .map(({ name }) => name)
      .filter((name) => typeof name === 'string'));
    if (!parseGeneratedChangeset(reservedContent, knownPackages)) {
      throw new Error('The reserved Dependabot Changeset is not canonical generated content; refusing to overwrite.');
    }
  } else if (reservedContent !== undefined) {
    throw new Error('Changeset blob data was supplied for a missing file.');
  }

  return {
    affectedPackages,
    changesetPath,
    content: desiredContent,
    shouldWrite: reservedContent !== desiredContent,
  };
}

export function verifyDependabotRun({ run, pullRequest, repository, workflowPath = SIGNAL_WORKFLOW_PATH }) {
  if (!run || !pullRequest || typeof repository !== 'string') return false;
  if (run.name !== SIGNAL_WORKFLOW_NAME || run.path?.split('@')[0] !== workflowPath) return false;
  if (run.event !== 'pull_request' || run.conclusion !== 'success') return false;
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) return false;
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1) return false;

  const runPullRequest = run.pull_requests[0];
  const head = pullRequest.head || {};
  const base = pullRequest.base || {};
  if (Number(runPullRequest.number) !== Number(pullRequest.number)) return false;
  if (run.head_branch !== head.ref || runPullRequest.head?.sha !== head.sha
      || runPullRequest.base?.sha !== base.sha) return false;
  if (pullRequest.state !== 'open' || pullRequest.user?.login !== 'dependabot[bot]') return false;
  if (base.repo?.full_name !== repository || head.repo?.full_name !== repository) return false;
  if (base.ref !== 'main' || !isSafeDependabotBranch(head.ref)) return false;
  return typeof head.sha === 'string' && /^[0-9a-f]{40}$/i.test(head.sha)
    && typeof runPullRequest.base?.sha === 'string' && /^[0-9a-f]{40}$/i.test(runPullRequest.base.sha)
    && typeof base.sha === 'string' && /^[0-9a-f]{40}$/i.test(base.sha);
}

export function decodeGitHubBlob(blob) {
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error('GitHub did not return a base64 blob.');
  }
  const encoded = blob.content.replace(/\s/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('GitHub returned an invalid base64 blob.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('GitHub returned an invalid base64 blob.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The reserved Changeset blob is not valid UTF-8.');
  }
}

export function createGitHubApi({ apiUrl, token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('A GitHub API token is required.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new Error('A valid GitHub API URL is required.');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('The GitHub API URL must be an HTTPS endpoint without credentials or query data.');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';

  return {
    async request(method, path, body) {
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
        throw new Error('GitHub API path is invalid.');
      }
      const url = new URL(path, base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
        throw new Error('GitHub API path escaped its configured endpoint.');
      }
      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jarvis-dependabot-changesets',
      };
      const options = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetchImpl(url, options);
      } catch {
        throw new Error(`GitHub API transport failed for ${method} ${url.pathname}.`);
      }
      if (!response.ok) throw new Error(`GitHub API ${method} ${url.pathname} failed (HTTP ${response.status}).`);
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        throw new Error(`GitHub API ${method} ${url.pathname} returned invalid JSON.`);
      }
    },
  };
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Repository identity is invalid.');
  }
}

async function listPullRequestFiles(api, repository, prNumber) {
  const files = [];
  for (let page = 1; page <= MAX_PULL_REQUEST_FILES / PAGE_SIZE; page += 1) {
    const result = await api.request(
      'GET',
      `repos/${repository}/pulls/${prNumber}/files?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(result) || result.some((file) => !file || typeof file.filename !== 'string')) {
      throw new Error('GitHub returned an invalid pull request file list.');
    }
    for (const file of result) {
      files.push(file.filename);
      if (typeof file.previous_filename === 'string') files.push(file.previous_filename);
    }
    if (result.length < PAGE_SIZE) return [...new Set(files)];
  }
  throw new Error('Pull request file list reached the API limit; refusing a partial plan.');
}

function assertTree(tree, label) {
  if (!tree || !Array.isArray(tree.tree) || tree.truncated) {
    throw new Error(`GitHub returned an incomplete ${label} tree.`);
  }
  return tree.tree;
}

async function getChangesetTree(api, repository, headSha, prNumber, changedFiles, workspaces) {
  const affectedPackages = getAffectedPackages({ workspaces, changedFiles });
  if (affectedPackages.length === 0) return buildChangesetPlan({ prNumber, changedFiles, workspaces });

  const commit = await api.request('GET', `repos/${repository}/git/commits/${headSha}`);
  if (commit?.sha !== headSha || typeof commit.tree?.sha !== 'string') {
    throw new Error('GitHub returned an invalid current PR commit.');
  }
  const rootTreeEntries = assertTree(
    await api.request('GET', `repos/${repository}/git/trees/${commit.tree.sha}`),
    'repository root',
  );
  const changesetDirectory = rootTreeEntries.find(({ path }) => path === '.changeset') || null;
  if (!changesetDirectory || changesetDirectory.type !== 'tree' || changesetDirectory.mode !== '040000') {
    return buildChangesetPlan({ prNumber, changedFiles, workspaces, changesetDirectory, changesetEntries: [] });
  }

  const changesetEntries = assertTree(
    await api.request('GET', `repos/${repository}/git/trees/${changesetDirectory.sha}`),
    'Changesets',
  );
  const reservedFilename = `dependabot-pr-${prNumber}.md`;
  const reservedEntry = changesetEntries.find(({ path }) => path === reservedFilename);
  let reservedContent;
  if (reservedEntry) {
    if (reservedEntry.type !== 'blob' || reservedEntry.mode !== '100644' || typeof reservedEntry.sha !== 'string') {
      return buildChangesetPlan({
        prNumber,
        changedFiles,
        workspaces,
        changesetDirectory,
        changesetEntries,
        reservedContent: '',
      });
    }
    reservedContent = decodeGitHubBlob(await api.request('GET', `repos/${repository}/git/blobs/${reservedEntry.sha}`));
  }

  return buildChangesetPlan({
    prNumber,
    changedFiles,
    workspaces,
    changesetDirectory,
    changesetEntries,
    ...(reservedEntry ? { reservedContent } : {}),
  });
}

function snapshotPullRequest(pullRequest) {
  return {
    number: Number(pullRequest.number),
    state: pullRequest.state,
    author: pullRequest.user?.login,
    baseRepository: pullRequest.base?.repo?.full_name,
    baseRef: pullRequest.base?.ref,
    baseSha: pullRequest.base?.sha,
    headRepository: pullRequest.head?.repo?.full_name,
    headRef: pullRequest.head?.ref,
    headSha: pullRequest.head?.sha,
  };
}

function digestPlan(repository, pullRequest, plan) {
  const stable = {
    repository,
    ...snapshotPullRequest(pullRequest),
    affectedPackages: plan.affectedPackages,
    changesetPath: plan.changesetPath,
    content: plan.content,
    shouldWrite: plan.shouldWrite,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export async function planDependabotWorkflowRun({ api, event, repository = DEFAULT_REPOSITORY, workspaces }) {
  validateRepository(repository);
  if (!Array.isArray(workspaces)) throw new Error('Trusted workspace metadata is required.');
  const eventRun = event?.workflow_run;
  if (!eventRun || !Number.isSafeInteger(Number(eventRun.id)) || Number(eventRun.id) < 1) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }

  const run = await api.request('GET', `repos/${repository}/actions/runs/${Number(eventRun.id)}`);
  if (Number(run?.id) !== Number(eventRun.id) || run?.repository?.full_name !== repository) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }
  if (eventRun.workflow_id && Number(run.workflow_id) !== Number(eventRun.workflow_id)) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }
  if (run.name !== SIGNAL_WORKFLOW_NAME || run.path?.split('@')[0] !== SIGNAL_WORKFLOW_PATH
      || run.event !== 'pull_request' || run.conclusion !== 'success'
      || run.head_repository?.full_name !== repository || !Array.isArray(run.pull_requests)
      || run.pull_requests.length !== 1) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }

  const runPullRequest = run.pull_requests[0];
  const prNumber = Number(runPullRequest?.number);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }
  const pullRequest = await api.request('GET', `repos/${repository}/pulls/${prNumber}`);
  if (!verifyDependabotRun({ run, pullRequest, repository })) {
    return { eligible: false, plan: emptyPlan(), digest: '' };
  }

  const initialSnapshot = snapshotPullRequest(pullRequest);
  const changedFiles = await listPullRequestFiles(api, repository, prNumber);
  const plan = await getChangesetTree(api, repository, pullRequest.head.sha, prNumber, changedFiles, workspaces);
  const currentPullRequest = await api.request('GET', `repos/${repository}/pulls/${prNumber}`);
  if (JSON.stringify(snapshotPullRequest(currentPullRequest)) !== JSON.stringify(initialSnapshot)) {
    throw new Error('The Dependabot PR changed while its Changeset plan was being validated.');
  }

  return {
    eligible: true,
    plan: { ...plan, prNumber },
    pullRequest,
    digest: digestPlan(repository, pullRequest, plan),
  };
}

export async function commitChangeset({ api, repository, headSha, headBranch, plan }) {
  validateRepository(repository);
  if (!plan || plan.shouldWrite !== true || !/^[1-9]\d*$/.test(String(plan.prNumber))) {
    throw new Error('A validated Changeset write plan is required.');
  }
  const expectedPath = `.changeset/dependabot-pr-${plan.prNumber}.md`;
  if (plan.changesetPath !== expectedPath || !Array.isArray(plan.affectedPackages)
      || plan.affectedPackages.length === 0 || buildChangeset(plan.affectedPackages) !== plan.content) {
    throw new Error('Changeset write plan failed canonical validation.');
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('Expected PR head SHA is invalid.');
  const branchPath = encodeRefPath(headBranch);
  const refPath = `repos/${repository}/git/ref/heads/${branchPath}`;
  const updateRefPath = `repos/${repository}/git/refs/heads/${branchPath}`;
  const currentRef = await api.request('GET', refPath);
  if (currentRef?.object?.type !== 'commit' || currentRef.object.sha !== headSha) {
    throw new Error('Dependabot branch head changed; refusing a stale Changeset write.');
  }

  const parent = await api.request('GET', `repos/${repository}/git/commits/${headSha}`);
  if (parent?.sha !== headSha || typeof parent.tree?.sha !== 'string') {
    throw new Error('GitHub returned an invalid parent commit.');
  }
  const blob = await api.request('POST', `repos/${repository}/git/blobs`, {
    content: plan.content,
    encoding: 'utf-8',
  });
  if (typeof blob?.sha !== 'string') throw new Error('GitHub did not create the Changeset blob.');
  const tree = await api.request('POST', `repos/${repository}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: [{ path: plan.changesetPath, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  if (typeof tree?.sha !== 'string') throw new Error('GitHub did not create the Changeset tree.');
  const commit = await api.request('POST', `repos/${repository}/git/commits`, {
    message: `chore(dependabot): add Changeset for PR ${plan.prNumber}`,
    tree: tree.sha,
    parents: [headSha],
  });
  if (typeof commit?.sha !== 'string') throw new Error('GitHub did not create the Changeset commit.');
  await api.request('PATCH', updateRefPath, { sha: commit.sha, force: false });
  return { changed: true, commitSha: commit.sha };
}

export function discoverTrustedWorkspaces(root = process.cwd(), pnpm = 'pnpm') {
  const trustedRoot = realpathSync(root);
  const output = execFileSync(pnpm, ['-r', 'list', '--depth', '-1', '--json'], {
    cwd: trustedRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('PNPM returned an invalid trusted workspace list.');
  return parsed.filter((workspace) => workspace && typeof workspace.name === 'string' && workspace.name
    && typeof workspace.path === 'string' && workspace.path)
    .map(({ name, path }) => {
      const absolutePath = realpathSync(isAbsolute(path) ? path : resolve(trustedRoot, path));
      if (!isWithin(trustedRoot, absolutePath)) throw new Error('A trusted workspace resolved outside the checkout.');
      return { name, path: normalizePath(relative(trustedRoot, absolutePath)) || '.' };
    });
}

export function parseTrustedWorkspaceJson(value) {
  if (typeof value !== 'string' || !value) throw new Error('Trusted workspace metadata from the pre-token plan is required.');
  let workspaces;
  try {
    workspaces = JSON.parse(value);
  } catch {
    throw new Error('Trusted workspace metadata is not valid JSON.');
  }
  if (!Array.isArray(workspaces) || workspaces.some((workspace) => !workspace
      || typeof workspace.name !== 'string' || !workspace.name
      || typeof workspace.path !== 'string' || !workspace.path || workspace.path.includes('\\')
      || isAbsolute(workspace.path)
      || (workspace.path !== '.' && workspace.path.split('/').some((part) => part === '..' || part === '.')))) {
    throw new Error('Trusted workspace metadata is invalid.');
  }
  return workspaces;
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const content = typeof value === 'string' ? value : JSON.stringify(value);
  const delimiter = `dependabot_changeset_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${content}\n${delimiter}\n`);
}

async function main() {
  const command = process.argv[2];
  if (!['plan', 'write'].includes(command)) throw new Error('Expected command: plan or write.');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY || '';
  if (repository !== DEFAULT_REPOSITORY) throw new Error(`This writer is restricted to ${DEFAULT_REPOSITORY}.`);
  const apiUrl = process.env.GITHUB_API_URL || '';
  const readApi = createGitHubApi({ apiUrl, token: process.env.GITHUB_TOKEN });
  const workspaces = command === 'write'
    ? parseTrustedWorkspaceJson(process.env.TRUSTED_WORKSPACES_JSON)
    : discoverTrustedWorkspaces(process.cwd(), process.env.PNPM_BIN || 'pnpm');
  const planned = await planDependabotWorkflowRun({ api: readApi, event, repository, workspaces });

  if (command === 'plan') {
    const expectedDigest = process.env.EXPECTED_PLAN_DIGEST;
    if (expectedDigest !== undefined && (!planned.eligible || planned.digest !== expectedDigest)) {
      throw new Error('The Dependabot PR plan changed between trusted workflow jobs; refusing to continue.');
    }
    writeOutput('eligible', String(planned.eligible));
    writeOutput('affected', String(planned.plan.affectedPackages.length > 0));
    writeOutput('should_write', String(planned.plan.shouldWrite));
    writeOutput('plan_digest', planned.digest);
    writeOutput('trusted_workspaces_json', JSON.stringify(workspaces));
    if (!planned.eligible) console.log('Workflow run is not an eligible current Dependabot PR; no write is planned.');
    else if (!planned.plan.affectedPackages.length) console.log('No versionable workspace package metadata changed; no Changeset is needed.');
    else if (!planned.plan.shouldWrite) console.log('The stable Dependabot Changeset is already current; no write is needed.');
    else console.log(`Validated a Changeset update for Dependabot PR #${planned.plan.prNumber}.`);
    return;
  }

  if (!planned.eligible || !planned.plan.shouldWrite) {
    throw new Error('The Dependabot Changeset plan is no longer eligible for writing.');
  }
  if (planned.digest !== process.env.EXPECTED_PLAN_DIGEST) {
    throw new Error('The Dependabot PR changed after validation; refusing to write.');
  }
  const writeApi = createGitHubApi({ apiUrl, token: process.env.APP_TOKEN });
  const result = await commitChangeset({
    api: writeApi,
    repository,
    headSha: planned.pullRequest.head.sha,
    headBranch: planned.pullRequest.head.ref,
    plan: planned.plan,
  });
  console.log(`Created Changeset commit ${result.commitSha} for Dependabot PR #${planned.plan.prNumber}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Dependabot Changeset operation failed.');
    process.exitCode = 1;
  });
}
