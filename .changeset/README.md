# Changesets

Use a Changeset to describe a user-visible package change that should be included in a future release. Run `pnpm changeset`, select every affected versionable workspace under `apps/*` or `packages/*`, choose its SemVer bump, and write a concise summary. Choose patch for a compatible fix, minor for compatible functionality, and major for an incompatible change; package versions are independent. The private repository root is not versionable.

Each versionable workspace has a `CHANGELOG.md` with a heading for its current version. Preserve that heading when editing a changelog; Changesets adds entries for packages whose Changesets are consumed, while unchanged packages keep their existing entries. Add the initial changelog and current-version heading when adding a versionable workspace.

All release workspaces are private. The release process creates package tags and GitHub Releases, not npm publications. Keep packages private and do not configure registry publication. See [package versioning and releases](../docs/development-workflow.md#package-versioning-and-releases) for CI checks and release operations, and the [release App setup guide](../docs/package-release-app-setup.md) for owner-provisioned credentials.
