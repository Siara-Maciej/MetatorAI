# Copilot: how to work in MetatorAI

This file is the light layer for GitHub Copilot (chat, coding agent, native code review). The heavy layer is the rule canon in `docs/metator/rules/`, rendered to `.github/instructions/mt-*.instructions.md` with `excludeAgent: code-review`: the `mt-pr-review` workflow and CI enforce those rules, so the native review does not repeat them.

## The repository in one paragraph

Bun monorepo, ports and adapters: `core` (domain → ports → application) ← `plugin-*` ← `runtime` ← `cli`, plus `desktop` (React, xterm.js over the daemon). Every file MetatorAI reads or writes is a versioned document (`kind`, `schemaVersion`). Imports use `.ts` inside a package and `@metator/<pkg>` across packages. Code, comments and the user site are English; design docs under `docs/` are Polish. Start with `AGENTS.md`, then the package's `AGENTS.md` and its card in `docs/metator/modules/`.

## Before you change code

- `bun run metator rules pack --paths <files>` prints the rules that apply to the files you touch; `bun run metator similar --file <new file>` finds the exemplar to copy.
- A new behavior gets a unit test in `packages/<pkg>/test/`, a user-facing change an e2e test in `e2e/` on the real `metator` process, a core or plugin module a mutant in `scripts/mutants.ts`.
- A schema change is a new version with an upgrade and a frozen snapshot (`bun run schemas:freeze`); a released version never changes.

## What a review comment here should be

- Point at a line and say what input or state makes it wrong; quote the code. A comment that cannot name a trigger is a question, not a finding.
- Do not re-check what tools already enforce: formatting (Biome), types (tsc), architecture (`bun run arch`), the canon rules (`bun run metator rules check`), generated files (`bun run metator generate --check`). CI is red when they fail.
- Prefer one comment that names the root cause to several that name its symptoms.

## Commands that prove the work

`bun run check` is everything CI runs (lint, typecheck, architecture, canon, unit, e2e, mutation smoke). `bun test <path>` runs one file.
