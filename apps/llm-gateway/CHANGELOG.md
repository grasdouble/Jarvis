# @jarvis/llm-gateway

## 0.1.0

### Minor Changes

- 1482f08: Add durable, per-dispatch provider usage and quota observations with exact runtime corroboration and unknown-safe recovery.
- fe736bf: - `@jarvis/llm-gateway`: Wire the bounded gateway to its trusted fixed filter endpoint while keeping production dispatch disabled.
  - `@jarvis/sandbox-manager`: Add optional per-attempt gateway/filter setup from closed trusted configuration.
  - `@jarvis/worker`: Compose stop-aware execution with the fixed manager relay.

### Patch Changes

- 6ef6e52: Add a closed owner-selected Copilot/OpenAI catalog, conservative prepared-message budgets and a shared untrusted plan/dev envelope. Bind trusted profile configuration through the worker's fixed OpenCode relay and sandbox manager to the gateway, while production provider dispatch remains disabled.
- Updated dependencies [6ef6e52]
- Updated dependencies [1482f08]
- Updated dependencies [01a95e6]
  - @jarvis/llm@0.1.0
  - @jarvis/contracts@0.1.0

## 0.0.0

- Initial private release of the bounded LLM gateway service.
