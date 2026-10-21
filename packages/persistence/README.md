# PostgreSQL persistence

`@jarvis/persistence` contains the PostgreSQL schema and the core-owned lease-bound checkpoint adapter. It accepts a pool implementing `SqlPool`; service startup remains responsible for configuring the PostgreSQL driver and connection credentials.

## Migration lifecycle

Call `PostgresPersistence.migrate()` once during controlled deployment, using a dedicated migrator connection. Migration execution is serialized with a PostgreSQL advisory lock, applied in transactions, and recorded with SHA-256 checksums. An applied migration is immutable; add a new numbered migration rather than editing one already recorded. The migrator needs schema/table creation privileges and `CREATEROLE` for the initial `jarvis_app` and `jarvis_agent` role setup. Do not use the runtime service login as a database superuser or migrator.

After migration, grant the runtime login membership in `jarvis_app` through deployment configuration. `jarvis_app` is a non-login role with no `DELETE` privilege and no `UPDATE` privilege on append-only configuration, policy, revision, checkpoint, report, evidence, skill-consent, decision, knowledge-version, or audit records. `jarvis_agent` is a non-login role with no schema grants; agent/model containers receive no database connection or database credentials. Database roles are an additional boundary, not a substitute for deterministic core validation.

The migration does not store provider credentials, raw provider sessions, or agent login material. Project-scoped composite foreign keys keep task, request, configuration, report, and checkpoint references within the same repository identity. Numeric GitHub identities use `bigint`; clients must serialize them as strings where JavaScript precision could be lost.

## Checkpoints

`saveCheckpoint` accepts only the closed, bounded core-state shape, binds it to its task configuration and policy, and writes only when the task/project/installation are active, the specified attempt owns the current unexpired lease epoch, and every exact skill revision remains approved under the task configuration. Unique task/attempt/epoch/step keys prevent duplicate checkpoints. `loadLatestCheckpoint` rechecks project, installation, configuration, and exact skill consent; callers must create a new lease and revalidate all external evidence before resuming work. A missing checkpoint is not evidence that a task is authorized.

Skill-consent decisions receive a database-assigned, strictly increasing order per project while holding the project-row lock. Authorization compares this order rather than caller-controlled `decided_at` timestamps or random UUIDs, so backdated or equal timestamps cannot make a later revocation ineffective. Migration `002_skill_approval_order` backfills existing decisions deterministically by `decided_at, id` and initializes each project's counter to its greatest assigned order.

Checkpoint data contains bounded identifiers/digests and stable reason codes, never prompts, plans, patches, credentials, or provider session state. Plans and review reports have separate immutable tables. The checkpoint interface is not wired into API/worker lifecycle or a live JARVIS database yet; migration and adapter tests alone do not qualify restart recovery or product operation.

## Verification

Run `pnpm --filter @jarvis/persistence run typecheck` and `pnpm --filter @jarvis/persistence run test`. To run the real PostgreSQL integration case, set `JARVIS_TEST_DATABASE_URL` to an exclusively used, empty disposable database whose name begins `jarvis_issue8_`. The test invokes both migrations, checks that application tables are empty, holds a database advisory lock, and commits its fixture. Before cleanup it locks all application tables and fails closed unless their row counts still exactly match the fixture; only then does it truncate the fixture tables with dependent rows. `psql "$JARVIS_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/persistence/test/schema.integration.sql` runs the additional schema privilege/scope checks after migrations. Use the repository's pinned PostgreSQL image on the dedicated `colima-jarvis` profile; unit tests without the URL use a fake pool and do not replace database integration or restore qualification. Do not run repository-provided commands from an analyzed product project until its separate execution policy is accepted and qualified.
