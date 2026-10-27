# Documents and schemas

Every file MetatorAI reads or writes is a versioned document: it starts with `kind` and `schemaVersion`. JSON and YAML files use top-level fields; Markdown files use front matter. A file from an older version is migrated when read. A file from a newer version is rejected and you are asked to update MetatorAI.

## Canon (committed, reviewed like code)

| Kind | File | Written by |
|---|---|---|
| `MetatorConfig` | `metator.config.yml` | you (`metator setup` and `metator init` propose it) |
| `RuleSet` | `docs/metator/rules/*.yml` | you |
| `Pattern` | `docs/metator/patterns/*.yml` | you |
| `ModuleCard` | `docs/metator/modules/*.card.md` | `metator cards build` (generated block) and you (curated sections) |
| `MemoryMap` | `docs/metator/memory-map.yml` | you |
| `Lesson` | `docs/metator/lessons/*.md` | `metator lessons add` after your approval |
| `ClaimSet` | `docs/metator/claims.json` | the docs analysis after your approval |
| `SystemMap` | `docs/metator/system.yml` | you |
| `Workflow` | `.github/metator/workflows/*.yml` | you (five are shipped) |
| `Agent` | `metator/agents/*.md` | you (23 are shipped) |
| `Skill` | `metator/skills/*/SKILL.md` | you (six are shipped) |
| `InstallLock` | `metator/install.lock.json` | `metator setup`, `metator agents install\|update` (never by hand) |
| `EvalCase` | `docs/metator/evals/golden/*.yml` | you |
| `InstructionsAdapter` | `.github/instructions/*.instructions.md` | `metator rules adapters` |

## Working state (`.metator/`, git-ignored)

| Kind | File | Written by |
|---|---|---|
| `Discovery` | `.metator/discovery.json` | `metator discover`, `metator init` |
| `ImportIndex` | `.metator/index/imports.json` | `metator index build` |
| `PatternIndex` | `.metator/index/patterns.json` | `metator patterns scan` |
| `ApiSnapshot` | `.metator/api/<package>.json` (`@scope/name` → `scope__name`) | `metator api snapshot` |
| `GateReport` | `.metator/gates/<gate>.json` | `metator gate` |
| `RunRecord` | `.metator/runs/<id>/state.json` | `metator run *` only |
| `RunLog` | `.metator/runs/<id>/log.md` | `metator run *` only (append-only) |
| `RunPointer` | `.metator/runs/latest.json` | `metator run *` |
| `RunHandoff` | `.metator/runs/<id>/handoff.md` | `metator run handoff` |
| `RunSummary` | `.metator/runs/<id>/summary.json` | `metator run close` |
| `EvalReport` | `<runs-dir>/report.json` | `metator eval run` |

## Run artifacts (written by agents, validated by hooks)

| Kind | File | Written by |
|---|---|---|
| `Analysis` | `analysis.json` | `mt-scout` |
| `Research` | `research.json` | `mt-pattern-miner` |
| `Plan` | `plan.json` | `mt-planner` |
| `PlanScope` | `plan-scope.json` | `metator plan scope` |
| `ReviewPlan` | `review-plan.json` | `metator review plan` |
| `FindingSet` | `findings/*.json`, `findings/merged.json` | review lenses, `metator findings merge` |
| `Verdict` | `verdict.json` | `metator findings verdict` |

## Print a schema

```bash
metator config schema      metator rules schema       metator patterns schema
metator memory schema      metator workflow schema    metator plan schema
metator findings schema    metator eval schema        metator system schema
metator docs claims-schema metator meta agents-schema metator meta skills-schema
metator run schema analysis|research|summary
```

The JSON Schema of every released version is also in the repository under `docs/metator/schemas/<Kind>.v<N>.json`.
