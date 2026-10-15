# Security reporting

JARVIS is in pre-release development. No released version currently receives security maintenance.

Do not put credentials, private source code, or exploit details in a public issue. Use GitHub's private vulnerability reporting when it is enabled for this repository. Otherwise, contact the repository owner through a previously established private channel. If no such channel is available, open an issue containing only a request for a private reporting channel.

For an exposed credential, revoke or rotate it first; deleting the visible file or rewriting Git history does not invalidate the credential. Preserve a sanitized incident record and assess Actions logs, artifacts, and affected installations.

Repository controls and development-agent access are documented in [repository security](docs/repository-security.md). Runtime isolation and production secret ownership are defined separately in the [technical architecture](docs/technical-architecture.md).
