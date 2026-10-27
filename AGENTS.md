# AGENTS.md: working on MetatorAI

MetatorAI is a host-agnostic agentic engineering workflow (GitHub Copilot, Claude Code). This repo is the product itself. Design docs (Polish): `docs/README.md`, start with `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`.

Before working in a package, read its `packages/<pkg>/AGENTS.md` and its card in `docs/metator/modules/`; keep the card's curated sections true when you change the package.

## Commands

| Task | Command |
|------|---------|
| Install | `bun install` |
| Everything CI runs | `bun run check` |
| Tests | `bun test` (one file: `bun test <path>`), `bun run test:unit`, `bun run test:e2e` |
| Mutation smoke | `bun run test:mutation` (`scripts/mutants.ts`) |
| Typecheck, lint, format | `bun run typecheck`, `bun run lint`, `bun run format` (Biome; Markdown not formatted) |
| Architecture rules | `bun run arch` |
| Canon and memory | `bun run canon` (`meta check-all --min-e1 100`) |
| Freeze schemas | `bun run schemas:freeze` |
| README visuals | `bun run assets` (never hand-edit `assets/*.svg`) |
| The CLI | `bun run metator <command>` |

## Architecture (enforced)

Ports and adapters; dependencies point inward: `core` (domain → ports → application) ← `plugin-*` ← `runtime` (the only place that knows adapters) ← `cli`. A plugin implements ports, imports only `@metator/core`, returns tool errors as `MetatorError` values and takes tool findings as SARIF 2.1.0 where the tool emits it (`diagnosticsFromSarif`). `rules/architecture/*.yml` (ast-grep) enforces it in CI. Never weaken a rule to make code pass; move the code.

## Rules that hold everywhere

- Every file MetatorAI reads or writes is a versioned document: `kind` + `schemaVersion` first (ADR-0016). A schema change is a new version with a migration and a frozen snapshot; a released version never changes (MT-CODE-003).
- Use a proven package before writing generic code (ADR-0010); every dependency is listed in `docs/metator/dependencies.yml` with its ADR (MT-CODE-005).
- Imports use `.ts` extensions inside a package and `@metator/<pkg>` across packages.
- Tests sit in `packages/<pkg>/test/*.test.ts` on `bun:test` (tests may use `_unsafeUnwrap()`).
- Code, comments, commits and the README are in English; design docs in `docs/` are in Polish.
- Coding rules are canon in `docs/metator/rules/` (`bun run metator rules show <id>`); every rule is E1, decided by a tool.

## Proving work

Nothing is done until it is proven:
1. Unit tests for every behavior (happy path, edges, errors as values); a bug gets a failing test first.
2. An e2e test for every user-facing change: the real `metator` process on a real temp repo (`e2e/`).
3. Every port adapter passes its contract suite (`packages/testing/src/contracts`).
4. Test the tests: make a new check fail once on purpose; every core and plugin module with behavior has a mutant (MT-TEST-003).
5. Run the command or render the asset yourself; `bun run check` is green; report what you ran and saw.

## Develop MetatorAI with MetatorAI

1. Before editing: `bun run metator rules pack --paths <files>`, the package card, `bun run metator similar --file <new file>`.
2. While editing: `bun run metator graph dependents <file> --transitive`.
3. After editing: `bun run metator graph affected --base origin/claude/foundation` to pick tests; `bun run metator rules check --base origin/claude/foundation`.
4. Before committing: `bun run metator cards build`, `bun run metator rules adapters` and `bun run metator generate` when structure, rules or agents changed; then `bun run canon` and `bun run check`.
5. A finished feature ends with updated user docs in `site/`.

## Generated files

Never edit them: `.github/instructions/mt-*` (from the rule canon), `.github/agents/`, `.claude/agents/`, the host skills (from `metator/agents` and `metator/skills`), the generated block of module cards.

## Decisions

ADRs live in `docs/adr/`. Agents draft them as `Proposed`; only a human marks one `Accepted`.
