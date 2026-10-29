# @metator/plugin-node

`WorkspaceReader`, `ManifestReader`, `PackageManagerDetector`, `PackageManager` and `CoverageReader` for Node repositories.

- Scripts run through the repository's own package manager, never a hard-coded `npm`.
- Pitfall: Workspaces of every manager (npm, yarn, pnpm, bun, lerna, rush) go through @manypkg; do not parse `package.json` globs by hand.
