ALTER TABLE jarvis.projects
  ADD COLUMN skill_approval_order bigint NOT NULL DEFAULT 0;

ALTER TABLE jarvis.project_skill_approvals
  ADD COLUMN decision_order bigint;

WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id
           ORDER BY decided_at, id
         ) AS decision_order
  FROM jarvis.project_skill_approvals
)
UPDATE jarvis.project_skill_approvals approval
SET decision_order = ordered.decision_order
FROM ordered
WHERE ordered.id = approval.id;

ALTER TABLE jarvis.project_skill_approvals
  ALTER COLUMN decision_order SET NOT NULL,
  ADD CONSTRAINT project_skill_approvals_decision_order_positive CHECK (decision_order > 0),
  ADD CONSTRAINT project_skill_approvals_decision_order_unique
    UNIQUE (project_id, skill_id, revision_digest, decision_order);

UPDATE jarvis.projects project
SET skill_approval_order = ordered.last_order
FROM (
  SELECT project_id, max(decision_order) AS last_order
  FROM jarvis.project_skill_approvals
  GROUP BY project_id
) ordered
WHERE ordered.project_id = project.id;

DROP INDEX jarvis.project_skill_approvals_current;
CREATE INDEX project_skill_approvals_current ON jarvis.project_skill_approvals
  (project_id, skill_id, revision_digest, decision_order DESC);

CREATE OR REPLACE FUNCTION jarvis.serialize_skill_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Allocate order while holding the same project-row lock that excludes
  -- checkpoint saves; caller-provided timestamps and UUIDs do not order consent.
  UPDATE jarvis.projects
  SET skill_approval_order = skill_approval_order + 1
  WHERE id = NEW.project_id
  RETURNING skill_approval_order INTO NEW.decision_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project not found for skill approval';
  END IF;
  RETURN NEW;
END;
$$;
