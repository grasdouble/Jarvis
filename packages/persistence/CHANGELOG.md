# @jarvis/persistence

## 0.1.0

### Minor Changes

- a262fa7: Add the single-owner onboarding, password login, server-side session and browser CSRF foundation.
- f653d84: Add the exported runtime-composition API and durable exact-attempt sandbox mapping, each as a minor API release. Persistence also exposes the fenced sandbox mapping store.
- e258d63: Add bounded queue transitions and PostgreSQL-backed durable task claims, fencing, retries, cancellation, and outbox reconciliation.
- a9c36c8: Add PostgreSQL migrations and lease-bound, consent-checked core checkpoints.
- d268715: Add durable owner stop controls and a stop-aware worker execution contract.
- 493b5bf: Add owner-authenticated project allowlist APIs backed by immutable, audited PostgreSQL configuration versions.

### Patch Changes

- bbce16c: Add an authenticated, read-only operational dashboard with scoped persisted read models and bounded redacted exports.
- 0137ae3: Add durable, idempotent project-request intake with clarification and authenticated API boundary contracts.
- c8b5838: Dependency updates
- 4ce0fea: Fix PostgreSQL request intake task and outbox parameter typing.
- f653d84: Persist sandbox creation reservations and resolve created sandboxes by their idempotency key during reconciliation.
- Updated dependencies [0137ae3]
- Updated dependencies [f653d84]
- Updated dependencies [e258d63]
- Updated dependencies [493b5bf]
  - @jarvis/domain@0.1.0
  - @jarvis/queue@0.1.0

## 0.0.0

- Initial private release of durable persistence adapters.
