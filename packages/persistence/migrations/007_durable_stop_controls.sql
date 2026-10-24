CREATE TABLE jarvis.stop_controls (
  scope text NOT NULL CHECK (scope IN ('global', 'project')),
  project_id uuid REFERENCES jarvis.projects(id) ON DELETE CASCADE,
  stopped boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 200),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX stop_controls_global ON jarvis.stop_controls(scope) WHERE scope = 'global';
CREATE UNIQUE INDEX stop_controls_project ON jarvis.stop_controls(project_id) WHERE scope = 'project';
INSERT INTO jarvis.stop_controls(scope, project_id, stopped, version, changed_by)
-- Fail closed on first install/restore. An owner must explicitly resume after
-- verifying the deployment before any queue consumer can dispatch effects.
VALUES ('global', NULL, true, 1, 'system');
GRANT SELECT, INSERT, UPDATE ON jarvis.stop_controls TO jarvis_app;
GRANT INSERT ON jarvis.audit_events TO jarvis_app;
REVOKE ALL ON jarvis.stop_controls FROM jarvis_agent;
