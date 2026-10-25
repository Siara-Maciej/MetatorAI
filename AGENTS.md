# AGENTS.md: working on MetatorAI

MetatorAI is a host-agnostic agentic engineering workflow (GitHub Copilot, Claude Code). This repo is the product itself.
Design docs (Polish): `docs/README.md`. Start with `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`.

## Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Everything CI runs | `bun run check` |
| Tests | `bun test` (single file: `bun test packages/core/test/graph.test.ts`) |
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
- `packages/cli`: driving adapter: argv → use case → JSON envelope → exit code.
- `packages/testing`: fakes and port contract suites.

`rules/architecture/*.yml` (ast-grep) enforces this in CI. Never weaken a rule to make code pass; move the code instead.

## Conventions

- **Errors are values:** return `Result<T, MetatorError>` from domain and application code; throw only for programmer errors (e.g. DI misconfiguration). Adapters convert exceptions at the edge.
- **Every port has a contract suite** in `packages/testing/src/contracts`. A new adapter must call it from its own test.
- **Small ports (ISP):** split by axis of change (`Linter` ≠ `Formatter`, readers ≠ writers).
- **CLI output** is always one JSON envelope line (`@metator/runtime` `serialize`), bounded in size.
- Imports use explicit `.ts` extensions inside a package and `@metator/<pkg>` across packages.
- Code, comments, commit messages and the public README are in English; design docs in `docs/` are in Polish.
- Tests sit in `packages/<pkg>/test/*.test.ts` and use `bun:test`. New behavior comes with tests; fix bugs with a failing test first.
- Do not add dependencies to `@metator/core`.

## Decisions

Architecture decisions live in `docs/adr/`. Agents draft ADRs as `Proposed`; only a human marks them `Accepted`.
