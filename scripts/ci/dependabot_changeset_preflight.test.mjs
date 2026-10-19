import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildChangeset,
  getAffectedPackages,
  inspectChangesetCandidate,
} from './dependabot_changeset_preflight.mjs';

test('selects a single workspace package whose package manifest changed', () => {
  assert.deepEqual(getAffectedPackages({
    workspaces: [{ name: '@jarvis/domain', path: 'packages/domain' }],
    changedFiles: ['packages/domain/package.json'],
  }), ['@jarvis/domain']);
});

test('selects and sorts multiple affected packages without duplicate entries', () => {
  assert.deepEqual(getAffectedPackages({
    workspaces: [
      { name: '@jarvis/web', path: 'apps/web' },
      { name: '@jarvis/domain', path: 'packages/domain' },
    ],
    changedFiles: [
      'apps/web/action.yml',
      'packages/domain/package.json',
      'packages/domain/package.json',
    ],
  }), ['@jarvis/domain', '@jarvis/web']);
});

test('treats root, lockfile, Actions, and pip-only changes as explicit no-ops', () => {
  assert.deepEqual(getAffectedPackages({
    workspaces: [
      { name: 'jarvis', path: '.' },
      { name: '@jarvis/domain', path: 'packages/domain' },
    ],
    changedFiles: [
      'package.json',
      'pnpm-lock.yaml',
      '.github/workflows/dependency.yml',
      '.github/requirements-ci.txt',
    ],
  }), []);
});

test('accepts the stable generated file on an identical rerun', () => {
  const root = makeCheckout();
  try {
    const expected = buildChangeset(['@jarvis/domain']);
    writeFileSync(path.join(root, '.changeset/dependabot-pr-42.md'), expected);
    const result = inspectChangesetCandidate({
      changedFiles: ['packages/domain/package.json'],
      workspaces: [{ name: '@jarvis/domain', path: 'packages/domain' }],
      prNumber: 42,
      candidateRoot: root,
    });
    assert.deepEqual(result, {
      affectedPackages: ['@jarvis/domain'],
      changesetFile: '.changeset/dependabot-pr-42.md',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allows the action to update a previous generated file when another package becomes affected', () => {
  const root = makeCheckout();
  try {
    writeFileSync(path.join(root, '.changeset/dependabot-pr-42.md'), buildChangeset(['@jarvis/domain']));
    const result = inspectChangesetCandidate({
      changedFiles: ['packages/domain/package.json', 'apps/web/action.yml'],
      workspaces: [
        { name: '@jarvis/domain', path: 'packages/domain' },
        { name: '@jarvis/web', path: 'apps/web' },
      ],
      prNumber: 42,
      candidateRoot: root,
    });
    assert.deepEqual(result, {
      affectedPackages: ['@jarvis/domain', '@jarvis/web'],
      changesetFile: '.changeset/dependabot-pr-42.md',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to overwrite a human-authored file at the reserved stable path', () => {
  const root = makeCheckout();
  try {
    writeFileSync(path.join(root, '.changeset/dependabot-pr-42.md'), '---\n@jarvis/domain: minor\n---\nHuman note\n');
    assert.throws(() => inspectChangesetCandidate({
      changedFiles: ['packages/domain/package.json'],
      workspaces: [{ name: '@jarvis/domain', path: 'packages/domain' }],
      prNumber: 42,
      candidateRoot: root,
    }), /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a dangling symlink at the reserved stable path', () => {
  const root = makeCheckout();
  try {
    symlinkSync('../../outside.md', path.join(root, '.changeset/dependabot-pr-42.md'));
    assert.throws(() => inspectChangesetCandidate({
      changedFiles: ['packages/domain/package.json'],
      workspaces: [{ name: '@jarvis/domain', path: 'packages/domain' }],
      prNumber: 42,
      candidateRoot: root,
    }), /reserved Dependabot Changeset path must be a regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses changed legacy Dependabot filenames that the pinned action may delete', () => {
  const root = makeCheckout();
  try {
    writeFileSync(path.join(root, '.changeset/dependabot-7.md'), '---\n@jarvis/domain: patch\n---\nDependency updates\n');
    assert.throws(() => inspectChangesetCandidate({
      changedFiles: ['packages/domain/package.json', '.changeset/dependabot-7.md'],
      workspaces: [{ name: '@jarvis/domain', path: 'packages/domain' }],
      prNumber: 42,
      candidateRoot: root,
    }), /preserve human-authored entries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeCheckout() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jarvis-dependabot-preflight-'));
  mkdirSync(path.join(root, '.changeset'));
  mkdirSync(path.join(root, 'packages/domain'), { recursive: true });
  return root;
}
