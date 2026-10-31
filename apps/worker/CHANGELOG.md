# @jarvis/worker

## 0.1.0

### Minor Changes

- f653d84: Add the exported runtime-composition API and durable exact-attempt sandbox mapping, each as a minor API release. Persistence also exposes the fenced sandbox mapping store.
- 8113fbb: Connect the worker's bounded OpenCode session flow to the sandbox-manager's lease-bound fixed relay.
- f452b9a: Expose composed stop-control handling and persisted global/project stop admission for workers.
- fe736bf: - `@jarvis/llm-gateway`: Wire the bounded gateway to its trusted fixed filter endpoint while keeping production dispatch disabled.
  - `@jarvis/sandbox-manager`: Add optional per-attempt gateway/filter setup from closed trusted configuration.
  - `@jarvis/worker`: Compose stop-aware execution with the fixed manager relay.
- d268715: Add durable owner stop controls and a stop-aware worker execution contract.

### Patch Changes

- dc3a749: Preserve stop-effect uncertainty until dispatch begins.
- 0743c63: Align sandbox creation responses with the documented worker-manager contract.
- f653d84: Persist sandbox creation reservations and resolve created sandboxes by their idempotency key during reconciliation.
- Updated dependencies [0137ae3]
- Updated dependencies [f653d84]
- Updated dependencies [e258d63]
- Updated dependencies [493b5bf]
  - @jarvis/domain@0.1.0
  - @jarvis/queue@0.1.0
  - @jarvis/contracts@0.0.1

## 0.0.0

- Initial private release of the background worker service.
