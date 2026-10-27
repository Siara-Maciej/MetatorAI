# Concepts

## The CLI and the envelope

Every `metator` command prints exactly one JSON object on stdout:

```json
{"ok":true,"data":{ ... }}
{"ok":false,"error":{"code":"CHECK_FAILED","message":"...","hint":"...","details":{ ... }}}
```

**Why:** agents parse it without guessing, and the `hint` tells them the next step. Exit codes are stable: `0` ok, `1` a check failed or something was not found, `64` usage error, `65` stale index. See [Output and exit codes](../api/cli.md).

## Versioned documents

Every file MetatorAI reads or writes starts with `kind` and `schemaVersion` (JSON and YAML fields, Markdown front matter). Older files are migrated when read; a file from a newer version is rejected with a clear message. The full list is in [Files and documents](../api/documents.md).

## The canon

Your project's knowledge lives in the repository, reviewed like code:

| Canon | Where | What it holds |
|---|---|---|
| Rules | `docs/metator/rules/*.yml` | conventions with an id (`SHOP-CODE-001`), scope, examples and how they are enforced |
| Patterns | `docs/metator/patterns/*.yml` | how your codebase solves recurring problems, with an exemplar to copy |
| Module cards | `docs/metator/modules/*.card.md` | per package: generated facts plus curated responsibility, invariants and pitfalls |
| ADRs | `docs/adr/*.md` | decisions; agents draft them as `Proposed`, only humans accept them |
| Memory map | `docs/metator/memory-map.yml` | every knowledge file, who reads and writes it, size budgets |
| Lessons | `docs/metator/lessons/*.md` | what runs taught, each with a citation |
| Claims | `docs/metator/claims.json` | statements from docs verified against the code |
| System map | `docs/metator/system.yml` | applications and the contracts between them |

## Enforcement levels

Each rule declares how it is enforced:

- **E1:** a tool decides (ast-grep, Biome, tsc or a conformance test). The rule fails CI.
- **E2:** the rule is checked by review lenses and appears in the rule pack for the files it applies to.
- **E3:** guidance only.

`metator rules coverage` reports the share of E1 rules; `metator rules scaffold <id>` starts turning an E2 rule into E1.

## Citations

Knowledge that talks about code cites it:

```markdown
Errors cross layers as one type [[cite: src/errors.ts:21 | "export class AppError extends Error {"]].
```

`metator memory validate` checks that the quote is still at (or near) that line; `--fix` updates lines of quotes that moved. A quote that is gone is reported as stale.

## Workflows and runs

A **workflow** is a YAML state machine in `.github/metator/workflows/`. It lists stages, their owners (agents, skills or scripts), artifacts, gates, loop limits, autonomy and the definition of done. `metator workflow lint` checks a workflow against a 16-section anatomy.

A **run** is one execution of a workflow for one task, stored in `.metator/runs/<id>/`:

- `state.json` holds the current stage, loops used and approvals;
- `log.md` is an append-only audit trail;
- artifacts are files such as `plan.json`, `findings/*.json`, `verdict.json`, `gates.json`.

A run moves only through `metator run advance` and `metator run approve`. Any session, CI job or AI host can resume it with `metator run status`.

## Human gates and autonomy

A stage marked `hitl: true` waits for a human: only `metator run approve <stage> --by <name>` moves it on. A run has an autonomy level:

| Level | Meaning |
|---|---|
| `L0` | every human gate asks you |
| `L1` (autopilot) | gates the workflow marks `skipAt: [L1]` are approved by the autonomy level and logged |
| `L2` | headless, e.g. a review in CI |

Gates marked `neverSkip` and external actions (`push`, `comment`) always need a person. Choosing `--choice autopilot` at a gate switches an L0 run to L1.

## Hooks

The AI host runs `metator guard ...` at fixed moments. For example, `guard pre-tool` runs before every tool use and denies:

- reads of secrets;
- destructive commands;
- during a run: edits outside the plan scope and pushes or comments without approval.

See [Hooks and guardrails](../how-to/hooks.md).

## Agents and skills

Canonical agents (`metator/agents/*.md`) have a role, a model tier, capabilities and the agents they may delegate to. Coordinators (`mt-orchestrator`, `mt-pr-review`) run a workflow and delegate; workers do one stage. Skills (`metator/skills/*/SKILL.md`) are reusable procedures with optional scripts. `metator generate` turns both into host files.
