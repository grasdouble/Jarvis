import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStopControlStore } from '../dist/index.js';

test('stop control state survives reads and project resume does not clear global stop', async () => {
  const statements = [];
  const projectId = '00000000-0000-4000-8000-000000000001';
  const pool = { connect: async () => ({
    query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes('FROM jarvis.projects')) return { rows: [{ id: projectId, version: null }], rowCount: 1 };
      if (sql.includes('SELECT')) return { rows: [{ scope: 'global', project_id: null, stopped: true, version: 1, changed_at: new Date(0), changed_by: 'owner' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }, release() {},
  }) };
  const store = new PostgresStopControlStore(pool);
  const state = await store.get({ projectId });
  assert.equal(state.global.stopped, true);
  await store.set({ projectId, stopped: false, expectedVersion: 0, ownerId: 'owner' });
  assert.equal(statements.some(({ sql }) => sql.includes('project_id') && sql.includes('INSERT')), true);
  assert.equal(statements.some(({ sql, values }) => sql.includes('INSERT INTO jarvis.audit_events') && values[0] === 'owner'), true);
});

test('project stop mutation refuses a syntactically valid but nonexistent project', async () => {
  const pool = { connect: async () => ({
    query: async (sql) => sql.includes('FROM jarvis.projects')
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 1 },
    release() {},
  }) };
  const store = new PostgresStopControlStore(pool);
  await assert.rejects(
    store.set({ projectId: '00000000-0000-4000-8000-000000000099', stopped: true, expectedVersion: 0, ownerId: 'owner' }),
    { code: 'PROJECT_NOT_FOUND' },
  );
});

test('global stop mutation rejects a stale expected version', async () => {
  const pool = { connect: async () => ({
    query: async (sql) => sql.startsWith('UPDATE jarvis.stop_controls')
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 1 },
    release() {},
  }) };
  const store = new PostgresStopControlStore(pool);
  await assert.rejects(store.set({ stopped: true, expectedVersion: 9, ownerId: 'owner' }), { code: 'STOP_VERSION_CONFLICT' });
});

test('restore activation suspends previously resumed state, advances its version, and audits atomically', async () => {
  const statements = [];
  const pool = { connect: async () => ({
    query: async (sql, values = []) => {
      statements.push({ sql, values });
      if (sql.includes('UPDATE jarvis.stop_controls')) {
        return { rows: [{ version: 8 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }) };
  const store = new PostgresStopControlStore(pool);

  assert.deepEqual(await store.suspendAfterRestore(), { version: 8, stopped: true });
  const update = statements.find(({ sql }) => sql.includes('UPDATE jarvis.stop_controls'));
  assert.match(update.sql, /stopped = true, version = version \+ 1/);
  assert.match(update.sql, /changed_by = 'system:restore'/);
  assert.match(update.sql, /WHERE scope = 'global' AND project_id IS NULL/);
  assert.ok(statements.findIndex(({ sql }) => sql === 'COMMIT') > statements.findIndex(({ sql }) => sql.includes('INSERT INTO jarvis.audit_events')));
  assert.deepEqual(statements.filter(({ sql }) => ['BEGIN', 'COMMIT'].includes(sql)).map(({ sql }) => sql), ['BEGIN', 'COMMIT']);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO jarvis.audit_events') && sql.includes("'system:restore'") && sql.includes("'stop.restore_suspend'")), true);

  await store.set({ stopped: false, expectedVersion: 8, ownerId: 'owner' });
  const resume = statements.find(({ sql, values }) => sql.includes('UPDATE jarvis.stop_controls') && sql.includes('changed_by = $2') && values[2] === 8);
  assert.deepEqual(resume.values, [false, 'owner', 8], 'only an authenticated owner holding the new restore version can resume');
});
