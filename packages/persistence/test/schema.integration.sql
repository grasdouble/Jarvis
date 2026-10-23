BEGIN;

DO $$ BEGIN
  IF has_schema_privilege('jarvis_agent', 'jarvis', 'USAGE') THEN
    RAISE EXCEPTION 'agent role must not access the persistence schema';
  END IF;
  IF NOT has_table_privilege('jarvis_app', 'jarvis.task_checkpoints', 'INSERT') THEN
    RAISE EXCEPTION 'core app role must be able to persist checkpoints';
  END IF;
  IF has_table_privilege('jarvis_app', 'jarvis.task_checkpoints', 'UPDATE') THEN
    RAISE EXCEPTION 'core app role must not rewrite checkpoints';
  END IF;
  IF has_table_privilege('jarvis_app', 'jarvis.audit_events', 'DELETE') THEN
    RAISE EXCEPTION 'core app role must not delete audit records';
  END IF;
  IF NOT has_table_privilege('jarvis_app', 'jarvis.owner_accounts', 'SELECT')
     OR NOT has_table_privilege('jarvis_app', 'jarvis.owner_accounts', 'INSERT')
     OR NOT has_table_privilege('jarvis_app', 'jarvis.owner_accounts', 'UPDATE')
     OR has_table_privilege('jarvis_app', 'jarvis.owner_accounts', 'DELETE') THEN
    RAISE EXCEPTION 'core app owner credential privileges must allow setup and account updates but not deletion';
  END IF;
  IF NOT has_table_privilege('jarvis_app', 'jarvis.owner_sessions', 'INSERT')
     OR NOT has_table_privilege('jarvis_app', 'jarvis.owner_sessions', 'UPDATE')
     OR has_table_privilege('jarvis_app', 'jarvis.owner_sessions', 'DELETE') THEN
    RAISE EXCEPTION 'core app session privileges must allow creation/revocation but not deletion';
  END IF;
  IF has_table_privilege('jarvis_agent', 'jarvis.owner_accounts', 'SELECT')
     OR has_table_privilege('jarvis_agent', 'jarvis.owner_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'agent role must not access owner authentication state';
  END IF;
  IF NOT has_table_privilege('jarvis_app', 'jarvis.queue_entries', 'INSERT')
     OR NOT has_table_privilege('jarvis_app', 'jarvis.queue_entries', 'UPDATE')
     OR has_table_privilege('jarvis_app', 'jarvis.queue_entries', 'DELETE') THEN
    RAISE EXCEPTION 'core app queue privileges must allow transitions but not deletion';
  END IF;
  IF has_table_privilege('jarvis_agent', 'jarvis.queue_entries', 'SELECT')
     OR has_table_privilege('jarvis_agent', 'jarvis.outbox', 'INSERT') THEN
    RAISE EXCEPTION 'agent role must not access queue or outbox state';
  END IF;
END $$;

INSERT INTO jarvis.audit_events (actor, action, resource, details_hash)
VALUES ('integration-test', 'schema-test', 'audit-1', repeat('a', 64));

DO $$ BEGIN
  BEGIN
    UPDATE jarvis.audit_events SET action = 'rewritten' WHERE resource = 'audit-1';
    RAISE EXCEPTION 'audit rows must be immutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $$;

INSERT INTO jarvis.installations (id, github_id, app_id, state)
VALUES ('00000000-0000-4000-8000-000000000001', 1001, 2001, 'active');
INSERT INTO jarvis.policies (id, version, canonical_json, hash)
VALUES ('00000000-0000-4000-8000-000000000002', 1, '{"version":1}', repeat('b', 64));

INSERT INTO jarvis.projects (id, repository_id, installation_id, owner_id, repository_name, state, config_version)
VALUES ('00000000-0000-4000-8000-000000000003', 3001,
        '00000000-0000-4000-8000-000000000001', 'owner-a', 'repo-a', 'active', 1);
INSERT INTO jarvis.project_config_versions
  (project_id, repository_id, version, config_json, config_hash, policy_hash, created_by)
VALUES ('00000000-0000-4000-8000-000000000003', 3001, 1, '{"authorized":true}', repeat('c', 64), repeat('b', 64), 'owner');

INSERT INTO jarvis.requests
  (id, owner_id, project_id, repository_id, mode, prompt_digest, state, idempotency_key, config_version, policy_hash)
VALUES ('00000000-0000-4000-8000-000000000004', 'owner-a', '00000000-0000-4000-8000-000000000003',
        3001, 'plan', repeat('d', 64), 'queued', 'request-1', 1, repeat('b', 64));
INSERT INTO jarvis.tasks
  (id, request_id, project_id, repository_id, mode, profile_hash, policy_hash, config_version, state, dedupe_key)
VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000003', 3001, 'plan', repeat('e', 64), repeat('b', 64), 1, 'running', 'task-1');
INSERT INTO jarvis.task_attempts
  (id, task_id, project_id, repository_id, ordinal, lease_epoch, lease_until, state)
VALUES ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005',
        '00000000-0000-4000-8000-000000000003', 3001, 1, 1, now() + interval '1 hour', 'active');

DO $$ BEGIN
  BEGIN
    INSERT INTO jarvis.task_checkpoints
      (task_id, attempt_id, project_id, repository_id, lease_epoch, step, schema_version, state_json, state_digest)
    VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006',
            '00000000-0000-4000-8000-000000000003', 9001, 1, 'bad-scope', 1,
            '{"phase":"plan_validated"}', repeat('f', 64));
    RAISE EXCEPTION 'cross-repository checkpoint references must be rejected';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

INSERT INTO jarvis.task_checkpoints
  (task_id, attempt_id, project_id, repository_id, lease_epoch, step, schema_version, state_json, state_digest)
VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000006',
        '00000000-0000-4000-8000-000000000003', 3001, 1, 'plan-ready', 1,
        '{"phase":"plan_validated","configVersion":1}', repeat('f', 64));

DO $$ BEGIN
  BEGIN
    UPDATE jarvis.task_checkpoints SET step = 'rewritten' WHERE step = 'plan-ready';
    RAISE EXCEPTION 'checkpoints must be immutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END $$;

ROLLBACK;
