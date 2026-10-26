# @metator/plugin-bun

`FileSystem`, `ProcessRunner` and the `test` rule engine on Bun.

- Conformance tests in `rules/conformance/<id>.test.ts` are rules: each needs a `rejects ...` case (ADR-0034).
- Pitfall: Paths are repo-relative with forward slashes on every platform.
