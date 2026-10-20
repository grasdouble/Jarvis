import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildChangesetPlan,
  commitChangeset,
  createGitHubApi,
  decodeGitHubBlob,
  discoverTrustedWorkspaces,
  parseTrustedWorkspaceJson,
  planDependabotWorkflowRun,
  verifyDependabotRun,
} from './dependabot_changeset_api.mjs';

const repo = 'grasdouble/Jarvis';
const workflowPath = '.github/workflows/dependabot-changesets.yml';
const workspace = [
  { name: '@jarvis/domain', path: 'packages/domain' },
  { name: '@jarvis/web', path: 'apps/web' },
];
const changesetDirectory = { path: '.changeset', mode: '040000', type: 'tree', sha: 'tree-changesets' };

test('plans a stable patch Changeset for one affected workspace from changed paths', () => {
  const plan = buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['packages/domain/package.json'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [],
  });

  assert.deepEqual(plan, {
    affectedPackages: ['@jarvis/domain'],
    changesetPath: '.changeset/dependabot-pr-42.md',
    content: '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n',
    shouldWrite: true,
  });
});

test('sorts and deduplicates multi-package changesets', () => {
  const plan = buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['apps/web/action.yml', 'packages/domain/package.json', 'packages/domain/package.json'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [],
  });

  assert.deepEqual(plan.affectedPackages, ['@jarvis/domain', '@jarvis/web']);
  assert.equal(plan.content, '---\n"@jarvis/domain": patch\n"@jarvis/web": patch\n---\n\nDependency updates\n');
});

test('treats root, lockfile, Actions, pip, and unrelated changes as no-ops without inspecting Changesets', () => {
  const plan = buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', '.github/requirements-ci.txt'],
    workspaces: [{ name: 'jarvis', path: '.' }, ...workspace],
    changesetDirectory: null,
    changesetEntries: [],
  });

  assert.deepEqual(plan, { affectedPackages: [], changesetPath: '', content: '', shouldWrite: false });
});

test('recognizes the exact generated content on a rerun without requesting a write', () => {
  const content = '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n';
  const plan = buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['packages/domain/package.json'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [{ path: 'dependabot-pr-42.md', mode: '100644', type: 'blob', sha: 'blob-1' }],
    reservedContent: content,
  });

  assert.equal(plan.shouldWrite, false);
});

test('updates only a canonical generated file when an additional workspace becomes affected', () => {
  const oldContent = '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n';
  const plan = buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['packages/domain/package.json', 'apps/web/package.json'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [{ path: 'dependabot-pr-42.md', mode: '100644', type: 'blob', sha: 'blob-1' }],
    reservedContent: oldContent,
  });

  assert.equal(plan.shouldWrite, true);
  assert.match(plan.content, /"@jarvis\/web": patch/);
});

test('refuses missing or symlink Changesets directories when an update needs a Changeset', () => {
  const input = {
    prNumber: 42,
    changedFiles: ['packages/domain/package.json'],
    workspaces: workspace,
    changesetEntries: [],
  };

  assert.throws(() => buildChangesetPlan({ ...input, changesetDirectory: null }), /real \.changeset directory/);
  assert.throws(() => buildChangesetPlan({
    ...input,
    changesetDirectory: { path: '.changeset', mode: '120000', type: 'blob', sha: 'symlink' },
  }), /real \.changeset directory/);
});

test('refuses unsafe, malformed, or human-authored content at the reserved path', () => {
  const entry = { path: 'dependabot-pr-42.md', mode: '100644', type: 'blob', sha: 'blob-1' };
  const input = {
    prNumber: 42,
    changedFiles: ['packages/domain/package.json'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [entry],
  };

  assert.throws(() => buildChangesetPlan({ ...input, reservedContent: '---\n"@jarvis/domain": minor\n---\nHuman\n' }), /refusing to overwrite/);
  assert.throws(() => buildChangesetPlan({
    ...input,
    changesetEntries: [{ ...entry, mode: '120000' }],
    reservedContent: '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n',
  }), /regular file/);
  assert.throws(() => buildChangesetPlan({
    ...input,
    workspaces: [{ name: 'jarvis', path: '.' }, ...workspace],
    reservedContent: '---\n"jarvis": patch\n---\n\nDependency updates\n',
  }), /not canonical generated content/);
});

test('refuses changed legacy Dependabot Changesets that still exist at the PR head', () => {
  assert.throws(() => buildChangesetPlan({
    prNumber: 42,
    changedFiles: ['packages/domain/package.json', '.changeset/dependabot-7.md'],
    workspaces: workspace,
    changesetDirectory,
    changesetEntries: [{ path: 'dependabot-7.md', mode: '100644', type: 'blob', sha: 'legacy' }],
  }), /changed legacy Dependabot Changeset/);
});

test('accepts only the expected completed Dependabot PR signal and current trusted PR facts', () => {
  const run = {
    id: 12,
    name: 'Dependabot changesets signal',
    path: `${workflowPath}@refs/pull/42/merge`,
    event: 'pull_request',
    conclusion: 'success',
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    head_branch: 'dependabot/npm_and_yarn/example-2.0.0',
    head_sha: 'a'.repeat(40),
    pull_requests: [{ number: 42, base: { sha: 'b'.repeat(40) }, head: { sha: 'a'.repeat(40) } }],
  };
  const pr = {
    number: 42,
    state: 'open',
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: repo } },
    head: {
      ref: run.head_branch,
      sha: run.head_sha,
      repo: { full_name: repo },
    },
  };

  assert.equal(verifyDependabotRun({ run, pullRequest: pr, repository: repo, workflowPath }), true);
  assert.equal(verifyDependabotRun({
    run: { ...run, pull_requests: [{ ...run.pull_requests[0], base: { sha: 'c'.repeat(40) } }] },
    pullRequest: pr,
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run: { ...run, pull_requests: [{ number: 42, head: { sha: 'a'.repeat(40) } }] },
    pullRequest: pr,
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run: { ...run, pull_requests: [{ ...run.pull_requests[0], base: { sha: 'not-a-sha' } }] },
    pullRequest: pr,
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run: { ...run, pull_requests: [{ number: 42, head: { sha: 'b'.repeat(40) } }] },
    pullRequest: pr,
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run,
    pullRequest: { ...pr, user: { login: 'attacker' } },
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run,
    pullRequest: { ...pr, base: { ...pr.base, ref: 'release' } },
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({
    run,
    pullRequest: { ...pr, head: { ...pr.head, ref: 'attacker/branch' } },
    repository: repo,
    workflowPath,
  }), false);
  assert.equal(verifyDependabotRun({ run, pullRequest: pr, repository: 'other/repo', workflowPath }), false);
});

test('decodes GitHub blob content as strict UTF-8 base64 data', () => {
  assert.equal(decodeGitHubBlob({ encoding: 'base64', content: Buffer.from('hello\n').toString('base64') }), 'hello\n');
  assert.throws(() => decodeGitHubBlob({ encoding: 'utf-8', content: 'hello' }), /base64 blob/);
  assert.throws(() => decodeGitHubBlob({ encoding: 'base64', content: '%%%=' }), /base64 blob/);
});

test('creates one commit parented to the verified head and updates the branch without force', async () => {
  const headSha = 'a'.repeat(40);
  const requests = [];
  const api = {
    async request(method, path, body) {
      requests.push({ method, path, body });
      if (method === 'GET' && path.includes('/git/ref/')) return { object: { sha: headSha, type: 'commit' } };
      if (method === 'GET' && path.endsWith(`/git/commits/${headSha}`)) return { sha: headSha, tree: { sha: 'base-tree' } };
      if (method === 'POST' && path.endsWith('/git/blobs')) return { sha: 'blob-sha' };
      if (method === 'POST' && path.endsWith('/git/trees')) return { sha: 'new-tree' };
      if (method === 'POST' && path.endsWith('/git/commits')) return { sha: 'commit-sha' };
      if (method === 'PATCH' && path.includes('/git/ref/')) return { object: { sha: 'commit-sha' } };
      throw new Error(`Unexpected request ${method} ${path}`);
    },
  };
  const plan = {
    prNumber: 42,
    affectedPackages: ['@jarvis/domain'],
    changesetPath: '.changeset/dependabot-pr-42.md',
    content: '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n',
    shouldWrite: true,
  };

  const result = await commitChangeset({
    api,
    repository: repo,
    headSha,
    headBranch: 'dependabot/npm_and_yarn/example-2.0.0',
    plan,
  });

  assert.deepEqual(result, { changed: true, commitSha: 'commit-sha' });
  const commit = requests.find((request) => request.path.endsWith('/git/commits'));
  assert.deepEqual(commit.body.parents, [headSha]);
  assert.deepEqual(commit.body.tree, 'new-tree');
  const tree = requests.find((request) => request.path.endsWith('/git/trees'));
  assert.deepEqual(tree.body.tree, [{
    path: '.changeset/dependabot-pr-42.md',
    mode: '100644',
    type: 'blob',
    sha: 'blob-sha',
  }]);
  const refUpdate = requests.find((request) => request.method === 'PATCH');
  assert.equal(refUpdate.body.force, false);
});

test('rejects a moved branch head before creating any Git objects', async () => {
  const headSha = 'a'.repeat(40);
  const requests = [];
  const api = {
    async request(method, path) {
      requests.push({ method, path });
      return { object: { sha: 'newer-head' } };
    },
  };

  await assert.rejects(() => commitChangeset({
    api,
    repository: repo,
    headSha,
    headBranch: 'dependabot/npm_and_yarn/example-2.0.0',
    plan: {
      prNumber: 42,
      affectedPackages: ['@jarvis/domain'],
      changesetPath: '.changeset/dependabot-pr-42.md',
      content: '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n',
      shouldWrite: true,
    },
  }), /branch head changed/);
  assert.equal(requests.length, 1);
});

test('does not retry or force an update when the branch advances between ref read and patch', async () => {
  const headSha = 'a'.repeat(40);
  const requests = [];
  const api = {
    async request(method, endpoint, body) {
      requests.push({ method, endpoint, body });
      if (method === 'GET' && endpoint.includes('/git/ref/')) {
        return { object: { sha: headSha, type: 'commit' } };
      }
      if (method === 'GET' && endpoint.endsWith(`/git/commits/${headSha}`)) {
        return { sha: headSha, tree: { sha: 'base-tree' } };
      }
      if (method === 'POST' && endpoint.endsWith('/git/blobs')) return { sha: 'blob-sha' };
      if (method === 'POST' && endpoint.endsWith('/git/trees')) return { sha: 'new-tree' };
      if (method === 'POST' && endpoint.endsWith('/git/commits')) return { sha: 'commit-sha' };
      if (method === 'PATCH' && endpoint.includes('/git/ref/')) {
        assert.equal(body.force, false);
        throw new Error('GitHub rejected the non-fast-forward ref update (HTTP 422).');
      }
      throw new Error(`Unexpected request ${method} ${endpoint}`);
    },
  };

  await assert.rejects(() => commitChangeset({
    api,
    repository: repo,
    headSha,
    headBranch: 'dependabot/npm_and_yarn/example-2.0.0',
    plan: {
      prNumber: 42,
      affectedPackages: ['@jarvis/domain'],
      changesetPath: '.changeset/dependabot-pr-42.md',
      content: '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n',
      shouldWrite: true,
    },
  }), /non-fast-forward/);
  assert.equal(requests.filter(({ method }) => method === 'PATCH').length, 1);
});

test('plans only from the successful signal, current PR API facts, changed-path API, and trusted workspace metadata', async () => {
  const sha = 'c'.repeat(40);
  const run = {
    id: 12,
    workflow_id: 5,
    name: 'Dependabot changesets signal',
    path: `${workflowPath}@refs/pull/42/merge`,
    event: 'pull_request',
    conclusion: 'success',
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    head_branch: 'dependabot/npm_and_yarn/example-2.0.0',
    head_sha: sha,
    pull_requests: [{ number: 42, base: { sha: 'd'.repeat(40) }, head: { sha } }],
  };
  const pullRequest = {
    number: 42,
    state: 'open',
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: 'd'.repeat(40), repo: { full_name: repo } },
    head: { ref: run.head_branch, sha, repo: { full_name: repo } },
  };
  const calls = [];
  const api = {
    async request(method, endpoint) {
      calls.push({ method, endpoint });
      if (endpoint.endsWith('/actions/runs/12')) return run;
      if (endpoint.endsWith('/pulls/42')) return pullRequest;
      if (endpoint.includes('/pulls/42/files?')) return [{ filename: 'packages/domain/package.json', status: 'modified' }];
      if (endpoint.endsWith(`/git/commits/${sha}`)) return { sha, tree: { sha: 'root-tree' } };
      if (endpoint.endsWith('/git/trees/root-tree')) return {
        truncated: false,
        tree: [changesetDirectory],
      };
      if (endpoint.endsWith('/git/trees/tree-changesets')) return { truncated: false, tree: [] };
      throw new Error(`Unexpected API call: ${method} ${endpoint}`);
    },
  };

  const result = await planDependabotWorkflowRun({
    api,
    event: { workflow_run: { id: 12, workflow_id: 5 } },
    repository: repo,
    workspaces: workspace,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.plan.shouldWrite, true);
  assert.equal(result.plan.prNumber, 42);
  assert.equal(result.plan.content, '---\n"@jarvis/domain": patch\n---\n\nDependency updates\n');
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(calls.filter(({ endpoint }) => endpoint.endsWith('/pulls/42')).length, 2);
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('/pulls/42/files?')));
  assert.ok(calls.every(({ endpoint }) => !endpoint.includes('/contents/')));
});

test('skips a stale workflow_run whose signaled PR head no longer matches the current API head', async () => {
  const runHead = 'e'.repeat(40);
  const currentHead = 'f'.repeat(40);
  const calls = [];
  const run = {
    id: 12,
    name: 'Dependabot changesets signal',
    path: `${workflowPath}@refs/pull/42/merge`,
    event: 'pull_request',
    conclusion: 'success',
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    head_branch: 'dependabot/npm_and_yarn/example-2.0.0',
    pull_requests: [{ number: 42, base: { sha: '1'.repeat(40) }, head: { sha: runHead } }],
  };
  const pullRequest = {
    number: 42,
    state: 'open',
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: '1'.repeat(40), repo: { full_name: repo } },
    head: { ref: run.head_branch, sha: currentHead, repo: { full_name: repo } },
  };
  const result = await planDependabotWorkflowRun({
    api: {
      async request(method, endpoint) {
        calls.push(endpoint);
        if (endpoint.endsWith('/actions/runs/12')) return run;
        if (endpoint.endsWith('/pulls/42')) return pullRequest;
        throw new Error(`Stale signal must stop before ${method} ${endpoint}`);
      },
    },
    event: { workflow_run: { id: 12 } },
    repository: repo,
    workspaces: workspace,
  });

  assert.equal(result.eligible, false);
  assert.equal(calls.length, 2);
});

test('runs workspace discovery from trusted checkout and rejects paths that escape it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jarvis-dependabot-trusted-'));
  const packagePath = path.join(root, 'packages/domain');
  const pnpm = path.join(root, 'pnpm-fixture');
  const marker = path.join(root, 'candidate-config-ran');
  try {
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(path.join(root, '.pnpmfile.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
    writeFileSync(pnpm, `#!/bin/sh\nprintf '%s' '[{"name":"@jarvis/domain","path":${JSON.stringify(packagePath)}}]'\n`, { mode: 0o700 });

    assert.deepEqual(discoverTrustedWorkspaces(root, pnpm), [
      { name: '@jarvis/domain', path: 'packages/domain' },
    ]);
    const escapePnpm = path.join(root, 'pnpm-escape');
    writeFileSync(escapePnpm, '#!/bin/sh\nprintf "%s" \'[{"name":"outside","path":"/etc"}]\'\n', { mode: 0o700 });
    assert.throws(() => discoverTrustedWorkspaces(root, escapePnpm), /outside the checkout/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts only a relative workspace snapshot emitted by the pre-token trusted plan', () => {
  const snapshot = JSON.stringify([
    { name: '@jarvis/domain', path: 'packages/domain' },
    { name: 'jarvis', path: '.' },
  ]);
  assert.deepEqual(parseTrustedWorkspaceJson(snapshot), JSON.parse(snapshot));
  assert.throws(() => parseTrustedWorkspaceJson('not-json'), /not valid JSON/);
  assert.throws(() => parseTrustedWorkspaceJson('[{"name":"outside","path":"../outside"}]'), /metadata is invalid/);
  assert.throws(() => parseTrustedWorkspaceJson('[{"name":"outside","path":"/etc"}]'), /metadata is invalid/);
});

test('keeps GitHub API credentials in the Authorization header and redacts API failures', async () => {
  let requestUrl;
  let requestOptions;
  const api = createGitHubApi({
    apiUrl: 'https://api.github.com/',
    token: 'synthetic-secret-token',
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return { ok: false, status: 403 };
    },
  });

  await assert.rejects(() => api.request('GET', 'repos/grasdouble/Jarvis'), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /synthetic-secret-token/);
    return true;
  });
  assert.equal(requestUrl.search, '');
  assert.equal(requestOptions.headers.Authorization, 'Bearer synthetic-secret-token');
  assert.equal(requestOptions.redirect, 'error');
  assert.equal(requestOptions.body, undefined);
});
