---
'@jarvis/llm-gateway': minor
'@jarvis/sandbox-manager': minor
'@jarvis/worker': minor
---

- `@jarvis/llm-gateway`: Wire the bounded gateway to its trusted fixed filter endpoint while keeping production dispatch disabled.
- `@jarvis/sandbox-manager`: Add optional per-attempt gateway/filter setup from closed trusted configuration.
- `@jarvis/worker`: Compose stop-aware execution with the fixed manager relay.
