-- Project identity is global at GitHub's stable repository ID. A renamed
-- repository remains the same allowlist entry, including after removal.
CREATE UNIQUE INDEX projects_repository_id_unique ON jarvis.projects(repository_id);
