# @jarvis/sandbox-manager

## 0.1.0

### Minor Changes

- 8113fbb: Connect the worker's bounded OpenCode session flow to the sandbox-manager's lease-bound fixed relay.
- fe736bf: - `@jarvis/llm-gateway`: Wire the bounded gateway to its trusted fixed filter endpoint while keeping production dispatch disabled.
  - `@jarvis/sandbox-manager`: Add optional per-attempt gateway/filter setup from closed trusted configuration.
  - `@jarvis/worker`: Compose stop-aware execution with the fixed manager relay.

### Patch Changes

- 0743c63: Align sandbox creation responses with the documented worker-manager contract.
- f653d84: Persist sandbox creation reservations and resolve created sandboxes by their idempotency key during reconciliation.
- @jarvis/contracts@0.0.1

## 0.0.0

- Initial private release of the isolated sandbox manager.
