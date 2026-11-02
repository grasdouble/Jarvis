# @jarvis/api

## 0.1.0

### Minor Changes

- a262fa7: Add the single-owner onboarding, password login, server-side session and browser CSRF foundation.
- f653d84: Add the exported runtime-composition API and durable exact-attempt sandbox mapping, each as a minor API release. Persistence also exposes the fenced sandbox mapping store.
- f452b9a: Expose composed stop-control handling and persisted global/project stop admission for workers.
- 1482f08: Add durable, per-dispatch provider usage and quota observations with exact runtime corroboration and unknown-safe recovery.
- 01a95e6: Persist bounded versioned plan/dev result envelopes atomically with lease-fenced queue completion and expose owner-scoped trusted reads.
- d268715: Add durable owner stop controls and a stop-aware worker execution contract.
- 493b5bf: Add owner-authenticated project allowlist APIs backed by immutable, audited PostgreSQL configuration versions.

### Patch Changes

- bbce16c: Add an authenticated, read-only operational dashboard with scoped persisted read models and bounded redacted exports.
- 0137ae3: Add durable, idempotent project-request intake with clarification and authenticated API boundary contracts.
- dbfebe3: Expose safely allowlisted provider quota signals and per-operation identity through the owner-scoped usage dashboard.
- 3034a76: Add the production authenticated UI serving composition and static asset support.
- Updated dependencies [bbce16c]
- Updated dependencies [0137ae3]
- Updated dependencies [a262fa7]
- Updated dependencies [f653d84]
- Updated dependencies [e258d63]
- Updated dependencies [c8b5838]
- Updated dependencies [1482f08]
- Updated dependencies [dbfebe3]
- Updated dependencies [a9c36c8]
- Updated dependencies [01a95e6]
- Updated dependencies [d268715]
- Updated dependencies [4ce0fea]
- Updated dependencies [493b5bf]
- Updated dependencies [f653d84]
  - @jarvis/persistence@0.1.0
  - @jarvis/domain@0.1.0
  - @jarvis/contracts@0.1.0

## 0.0.0

- Initial private release of the JARVIS API service.
