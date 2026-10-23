# @jarvis/persistence

## 0.1.0

### Minor Changes

- a262fa7: Add the single-owner onboarding, password login, server-side session and browser CSRF foundation.
- e258d63: Add bounded queue transitions and PostgreSQL-backed durable task claims, fencing, retries, cancellation, and outbox reconciliation.
- a9c36c8: Add PostgreSQL migrations and lease-bound, consent-checked core checkpoints.

### Patch Changes

- 0137ae3: Add durable, idempotent project-request intake with clarification and authenticated API boundary contracts.
- 4ce0fea: Fix PostgreSQL request intake task and outbox parameter typing.
- Updated dependencies [0137ae3]
- Updated dependencies [e258d63]
  - @jarvis/domain@0.0.1
  - @jarvis/queue@0.1.0
