# AGENTS.md: working on MetatorAI

MetatorAI is a host-agnostic agentic engineering workflow (GitHub Copilot, Claude Code). This repo is the product itself.
Design docs (Polish): `docs/README.md`. Start with `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`.

## Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Everything CI runs | `bun run check` |
| All tests | `bun test` (single file: `bun test packages/core/test/graph.test.ts`) |
| Unit tests | `bun run test:unit` (`packages/*/test`) |
| E2E tests | `bun run test:e2e` (`e2e/`: real CLI processes, README visuals in Chromium) |
| Mutation smoke | `bun run test:mutation` (injected bugs must make unit tests fail) |
| README visuals | `bun run assets` regenerates `assets/*.svg` from `scripts/assets/generate.ts` |
| Typecheck | `bun run typecheck` (TypeScript 7, `noEmit`) |
| Lint + format | `bun run lint` / `bun run format` (Biome; Markdown is not formatted) |
| Architecture rules | `bun run arch` (ast-grep rule tests + scan) |
| Run the CLI | `bun run metator <command>` |

## Architecture (enforced, not advisory)

Clean architecture, ports and adapters. Dependencies point inward:

- `packages/core/src/domain`: pure TypeScript. No I/O, no `node:*`, no `bun`, no ports/application imports.
- `packages/core/src/ports`: interfaces only, may import `domain`.
- `packages/core/src/application`: use cases. Depend on ports via constructor injection, return `Result`.
- `packages/plugin-*`: adapters implementing ports. May import `@metator/core` only.
- `packages/runtime`: DI container, envelope, tokens: the only place that knows concrete implementations.
- `packages/cli`: driving adapter on commander: `src/commands/*.ts` (one module per command group, `register*(program, ctx)`), `program.ts` (JSON-only commander setup), `run.ts` (envelope + exit code). Validate values with commander (`Option.choices`, `Argument.choices`, `requiredOption`), not by hand.
- `packages/testing`: fakes and port contract suites.

`rules/architecture/*.yml` (ast-grep) enforces this in CI. Never weaken a rule to make code pass; move the code instead.

## Every file is a versioned document (ADR-0016)

- Every file MetatorAI writes or reads starts with `kind` + `schemaVersion` (JSON/YAML top-level fields, Markdown front matter).
- Define documents with `defineDocument(kind, { latest, upgrade?, history? })` (`packages/core/src/domain/versioned.ts`). Write only through `Document.stamp(body)`; read only through `Document.parse(raw, source)`.
- Changing a document's schema means a new version, a migration (`upgrade`) and a migration test. Never change a released version in place.
- `schemaVersion` is the file format; content versions use separate fields (e.g. a workflow's `revision`).
- `e2e/helpers/versioned.ts` (`findUnversioned`) fails CI for any unversioned file under `.metator/` or `.github/metator/`.

## Dependency policy: don't reinvent the wheel

Use a proven package before writing your own (ADR-0010). Write code only for logic specific to MetatorAI.

| Need | Package | Where |
|------|---------|-------|
| DI | `awilix` (via `createMetatorContainer`, `resolvePort`) | `packages/runtime` |
| Dependency graph, graph algorithms | `@dagrejs/graphlib` | `packages/core/src/domain/graph.ts` |
| State machines (workflow runs) | `xstate` v5, pure `transition()` | `packages/core/src/domain/run-machine.ts` |
| Result / errors as values | `neverthrow` | everywhere (`@metator/core` re-exports it) |
| Glob matching | `picomatch` | `packages/core/src/domain/glob.ts` |

- Before adding code that looks generic (parsing, validation, graphs, retries, caching, CLI args, YAML, schemas, diffing), search npm and propose a package with an ADR (criteria in ADR-0010).
- `@metator/core` may import only the approved pure libraries above; `mt-arch-core-approved-deps` (ast-grep) fails CI otherwise.
- Wrap libraries thinly so their errors come back as `MetatorError`; do not re-implement their features.

## Testing policy: prove every piece of work actually works

Nothing is done until it is proven, by tests and by running it yourself.

1. **Unit tests for every behavior** in `packages/<pkg>/test/*.test.ts`: happy path, edge cases, errors as values. Bugs get a failing test first.
2. **An e2e test for every user-facing change** in `e2e/*.e2e.test.ts`. It exercises the real entrypoint: the `metator` process (`e2e/helpers/cli.ts`), real files in a temp repo, a real browser for visuals. It does not call internals.
3. **Every port adapter passes its contract suite** (`packages/testing/src/contracts`).
4. **Test the tests.** When adding a check, make it fail once on purpose (break the code, see red, restore). Add a mutant to `scripts/mutation-smoke.ts` for each critical behavior.
5. **Self-verify before committing:** run the command or render the asset and look at the output. `bun run check` must be green. Report what you ran and what you saw.
6. **Visual assets are tested too:** `e2e/assets.e2e.test.ts` renders every SVG in several fonts and fails on overflow, collisions, missing animation or generator drift. Never hand-edit `assets/*.svg`.

## Conventions

- **Errors are values:** return neverthrow `Result<T, MetatorError>` from domain and application code (check with `isOk()`/`isErr()`; tests may use `_unsafeUnwrap()`); throw only for programmer errors (e.g. DI misconfiguration). Adapters convert exceptions at the edge.
- **Every port has a contract suite** in `packages/testing/src/contracts`. A new adapter must call it from its own test.
- **Small ports (ISP):** split by axis of change (`Linter` ≠ `Formatter`, readers ≠ writers).
- **CLI output** is always one JSON envelope line (`@metator/runtime` `serialize`), bounded in size.
- Imports use explicit `.ts` extensions inside a package and `@metator/<pkg>` across packages.
- Code, comments, commit messages and the public README are in English; design docs in `docs/` are in Polish.
- Tests sit in `packages/<pkg>/test/*.test.ts` and use `bun:test`. New behavior comes with tests; fix bugs with a failing test first.
- Do not add dependencies to `@metator/core` outside the approved list (ADR-0010).

## Decisions

Architecture decisions live in `docs/adr/`. Agents draft ADRs as `Proposed`; only a human marks them `Accepted`.
