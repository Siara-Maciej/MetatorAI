# @metator/plugin-bun

`FileSystem`, `FileLock`, `MachineState`, `ProcessRunner`, `BackgroundProcess`, `Launcher`, `DataIsolator` (Bun's Postgres client), `TreeCopier` and the `test` rule engine on Bun.

- Conformance tests in `rules/conformance/<id>.test.ts` are rules: each needs a `rejects ...` case (ADR-0034).
- Pitfall: Paths are repo-relative with forward slashes on every platform.
- `FileSystem.write` replaces a file whole (a temporary file renamed into place); `FileLock` and `MachineState.locked` share `withLockFile` (`<file>.lock`, taken over when its process is gone or it was not refreshed).
