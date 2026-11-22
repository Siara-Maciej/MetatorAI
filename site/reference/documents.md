# Documents and schemas

This page lists every file MetatorAI reads or writes: its kind, where it lives and who writes it. Use it to find a file, or to learn what a file in your repository is for.

Every file MetatorAI reads as data is a versioned document. It starts with `kind` and `schemaVersion`: as top-level fields in JSON and YAML, as front matter in Markdown.

Two kinds of files are written for people and carry no header: views rendered from a document (`.metator/arch/report.md` and `report.html`) and the Markdown notes agents leave in a run's directory (`task.md`, `gates.md`, `build-log.md` and the like). MetatorAI never parses them.

```yaml
kind: MetatorConfig
schemaVersion: 15
```

A file with an older `schemaVersion` is upgraded when it is read. A file with a newer one is refused, and the error asks you to upgrade MetatorAI.

## Committed files

These live in the repository and are reviewed like code.

| Kind | File | Written by |
|---|---|---|
| `MetatorConfig` | `metator.config.yml` | you; `metator setup` and `metator init` propose it |
| `RuleSet` | `docs/metator/rules/*.yml` | you |
| `Pattern` | `docs/metator/patterns/*.yml` | you |
| `ModuleCard` | `docs/metator/modules/*.card.md` | `metator cards build` (the generated block) and you (the other sections) |
| `MemoryMap` | `docs/metator/memory-map.yml` | you |
| `Lesson` | `docs/metator/lessons/*.md` | `metator lessons add` |
| `ClaimSet` | `docs/metator/claims.json` | the docs analysis, after your approval |
| `InstructionsAdapter` | `.github/instructions/*.instructions.md` | `metator rules adapters` |
| `Workflow` | `.github/metator/workflows/*.yml` | shipped; you may change or add them |
| `Agent` | `metator/agents/*.md` | shipped; you may change or add them |
| `Skill` | `metator/skills/*/SKILL.md` | shipped; you may change or add them |
| `InstallLock` | `metator/install.lock.json` | `metator setup`, `metator agents install` and `agents update`; never by hand |
| `HostManifest` | `metator/hosts/<host>.yml` | you, optionally; replaces the shipped description of how a host's terminal is read |
| `AnswerPolicies` | `metator/answer-policies.yml` | `metator run answer ... --always`; `metator policy rm` removes one |
| `Environment` | `metator/environment.yml` | you; `metator env init` proposes it |
| `ArchitecturePolicy` | `metator/architecture.yml` | you; `metator arch init` proposes it |
| `ArchitectureBaseline` | `metator/arch-baseline.json` | `metator arch baseline` |
| `RefactorPlan` | `metator/arch/plans/<id>.yml` | you or `mt-arch-planner`; `metator arch plan` simulates, approves and runs it |
| `SystemMap` | `docs/metator/system.yml` | you (also in the app); `metator system discover` proposes it |
| `SystemAnalysis` | `metator/system/plans/<id>.analysis.yml` | `metator system analyze`, then you or `mt-system-scout` |
| `SystemPlan` | `metator/system/plans/<id>.yml` | `metator system plan new`, then `mt-system-planner` (you ask for changes at its approval); `system plan approve`, `system plan retry` and `system plan step-plan` are yours. v3: a step's `planRunId`, the run that planned it on its own |
| `PlanRevision` | `.metator/runs/<id>/plan.previous.json`, `metator/system/plans/<id>.previous.json` | MetatorAI, when a run goes back to its plan's stage: the version its planner revises |
| `PlanEdit` | `docs/metator/system.edits.jsonl`, one line per edit | the app, when a person changes the map |
| `EvalCase` | `docs/metator/evals/golden/*.yml` | you; `metator eval seed` adds cases |
| `ArchEvalCase` | `docs/metator/evals/arch/*.yml` | you |
| `SystemEvalCase` | `docs/metator/evals/system/*.yml` | you |
| `AgentScenario` | any `*.yml` that `METATOR_AGENT_SCENARIO` points at | you; a scripted host plays it in tests |
| `RepoSet` | `metator.repos.yml` in a folder of repositories | you; `metator repos init` proposes it. v2: a repository's `worktrees` (its other checkouts in the folder, folder-relative); a v1 file that lists a worktree as a repository reads it as that repository's worktree, with a hint |

## A run's folder

Each run has a folder, `.metator/runs/<id>/`. Only `metator` commands write the state. Agents write the artifacts, and hooks check them against their schema.

| Kind | File | Written by |
|---|---|---|
| `RunRecord` | `state.json` | `metator run ...` only. v8: `resumes` (each time a person resumed the escalated run: who, from which stage to which, their note for the next agent). v9: the status `planned` (a run `--until plan` whose plan was approved), `until`, and `planFrom` (the run whose approved plan it took, and whether it started at `build` or at the plan's `review`) |
| `RunLog` | `log.md` | `metator run ...` only; append-only |
| `RunActivity` | `activity.jsonl`, one document per line | `metator run drive`; a `plan-edited` line when a person changes the plan in the app |
| `RunDriver` | `driver.json` | `metator run drive` |
| `RunHandoff` | `handoff.md` | `metator run handoff` |
| `RunSummary` | `summary.json` | `metator run close` |
| `QuickRun` | `quick.json` | `metator quick start --override` and the card **This grew past quick**: what a person kept quick although an escalator tripped, who, and in which words |
| `RunSeen` | `seen.json` | `metator run brief` |
| `Question` | `questions/qNNN.json` | `metator run drive` asks; `metator run answer` answers |
| `RunMessage` | `messages/mNNN.json` | `metator run message` |
| `AgentUsage` | `usage.jsonl`, one line per agent call | `metator run drive` |
| `WorkerResult` | `results/<worker>.json` | `metator run result`; `metator run collect` reads it |
| `ReviewNotes` | `review/notes.json` | `metator review notes ...` and the app's Changes screen |
| `Analysis` | `analysis.json` | `mt-scout` |
| `Research` | `research.json` | `mt-pattern-miner` |
| `Plan` | `plan.json` | `mt-planner`; you in the app, until the plan is approved |
| `PlanScope` | `plan-scope.json` | `metator plan scope` |
| `ReviewMetadata` | `pr.json` | `metator review metadata` |
| `ReviewPlan` | `review-plan.json` | `metator review plan` |
| `FindingSet` | `findings/*.json`, `findings/merged.json` | the review agents; `metator findings merge` |
| `Verdict` | `verdict.json` | `metator findings verdict` |

## Working state

These live under `.metator/`, which is git-ignored. They are derived or local, and can be rebuilt.

| Kind | File | Written by |
|---|---|---|
| `RunPointer` | `.metator/runs/latest.json` | `metator run ...` |
| `Discovery` | `.metator/discovery.json` | `metator discover`, `metator init` |
| `ImportIndex` | `.metator/index/imports.json` | `metator index build` |
| `PatternIndex` | `.metator/index/patterns.json` | `metator patterns scan` |
| `ApiSnapshot` | `.metator/api/<package>.json` | `metator api snapshot` |
| `GateReport` | `.metator/gates/<gate>.json` | `metator gate` |
| `ArchitectureReport` | `.metator/arch/report.json` | `metator arch analyze` |
| `Issue` | `.metator/issues/iNNN.json` | `metator issue ...`: one task of the backlog. v3: its analysis and plan (each a snapshot: the file, the commit, every cited file with its SHA-256, the packages they belong to), the chat it belongs to (`threadId`), its parent and the tasks it waits for (`dependsOn`), and the system plan step a part carries out (`step`). A v2 file reads as a task that waits for nothing |
| (none) | `.metator/issues/iNNN/analysis.md`, `plan.json`, `system-plan.yml` | `metator issue analyze`, `issue plan`, `issue from-plan`: a task's analysis (the agent's Markdown and the facts MetatorAI adds; a note for people, never parsed) and a copy of its plan |
| `PullRequestReview` | `.metator/mrs/<host>-<repo>-<number>.json` | the daemon and `metator mrs ...`: the review threads of your request |
| `WatchedReview` | `.metator/reviews/<host>-<owner>-<repo>-<number>.json` | `metator review ...` and the daemon: someone else's request MetatorAI reviewed from its link or that asks you for a review: the request, the head the last review read, the comments published with their ids at the host, every finding with its state (`open`, `fixed`, `not-fixed`, `disputed`, `outdated`) and the agent's reason, what is new since, and when watching ended ([Review a change](../use/reviews.md#review-a-pull-request-from-its-link)) |
| `Conversation` | `.metator/conversations/<id>.json` | `metator ask` |
| `WorktreeRegistry` | `.metator/worktrees.json` | `metator worktree ...`, `metator run new --worktree` |
| `EnvState` | `.metator/env/*.json` | `metator env up` and `env down` |
| `EnvProfile` | `.metator/env-profile.json` | `metator env analyze` |
| `Layout` | `.metator/layout.json` | the daemon: workspaces, tabs and panes, restored after a restart (v5: a chat's pane names its thread, `threadId`) |
| `Thread` | `.metator/threads/<id>.json` | the daemon and `metator thread ...`: one chat's topic, the summary its agent keeps, its runs, its terminals and the facts the daemon adds ([Chats and threads](../use/start.md#what-a-chat-keeps)) |
| `DaemonInfo` | `.metator/daemon.json` | `metator serve`, while it runs |
| `PaneTyped` | `.metator/typed/<pane>.json` | the daemon: a hash and a time for each line it typed into a pane (never the words), so a host's user-prompt hook can tell the daemon's lines from your own typing |
| `GuardAsked` | `.metator/guard-asked/<pane>.json` | the `pre-tool` hook: why the guard asked about (or refused) a pane's command lately, with a hash of the command (never the command), so the card of your host's approval says why |
| `PaneMail` | `.metator/pane-mail.json` | the daemon: lines that wait to be typed into an agent's session when it is idle (`metator session tell`, the note that you spoke to a session directly) |
| `ScratchRecord` | `.metator/scratch/sNNN.json` | `metator scratch end`: one recorded change not meant for a commit, with its patch |
| `ScratchOpen` | `.metator/scratch/open.json` | `metator scratch begin`, until `scratch end` |
| `GuardConsents` | `.metator/consents/<pane or session>.json` | `metator guard user-prompt`: the consents you gave in words, each used once |
| `HostConformance` | `.metator/conformance/conformance-<host>-<version>.json` (or `--out`) | `metator host conformance`: one run of the host conformance suite against a host's real CLI, each check with its result and evidence; `metator host conformance diff` compares two |
| `FileLock` | `<file>.lock` next to a file under `.metator/` | any command, only while it changes that file (the worktree registry, a run's `state.json`, the backlog); a lock whose process is gone holds nothing |
| `ReviewReaction` | `.metator/telemetry/reactions.jsonl` | `metator findings react`: what people did with a review comment |
| `QuarterlyReview` | `.metator/reviews/quarterly-<date>.json` | `metator meta quarterly` |
| `EvalReport` | `report.json` under the `--runs-dir` of `metator eval run` (default `.metator/evals`) | `metator eval run` |

A thread, as `metator thread show --json` and `GET /threads/<id>` hold it (without the tasks and the chat they add):

```json
{
  "kind": "Thread",
  "schemaVersion": 1,
  "id": "20261122-price-rounding",
  "title": "Price rounding",
  "state": "open",
  "createdAt": "2026-11-22T09:12:00.000Z",
  "updatedAt": "2026-11-22T10:40:00.000Z",
  "summary": "Decided: round half up, per line.\nOpen: the invoice total.",
  "runs": ["20261122-mt-feature-round-prices-half-up"],
  "issues": [],
  "mrs": [],
  "panes": [{ "paneId": "w1:p2", "at": "2026-11-22T09:12:00.000Z" }],
  "facts": [
    { "at": "2026-11-22T09:12:00.000Z", "text": "opened by ana" },
    { "at": "2026-11-22T09:30:00.000Z", "text": "run 20261122-mt-feature-round-prices-half-up started: Round prices half up" },
    { "at": "2026-11-22T10:40:00.000Z", "text": "run 20261122-mt-feature-round-prices-half-up done: Round prices half up" }
  ]
}
```

`state` is `open` or `closed` (with `closedAt`); `panes` lists the chat's terminals, the last one current, each with the host session it ran once it ended (`hostSession`); `from` names the thread or Backlog item it came from; `facts` keeps the newest 50; `issues` and `mrs` stay empty for now.

## On your machine

| Kind | File | Written by |
|---|---|---|
| `UserOptions` | `~/.config/metator/options.yml` | `metator config set ... --scope user` and the app's **Settings** screen; `mcp:` by hand |
| `PortLeases` | `~/.local/state/metator/port-leases.json` | `metator worktree new` and `worktree rm` |
| `FileLock` | `~/.local/state/metator/port-leases.json.lock` | the same commands, only while they change the leases |

`METATOR_CONFIG_DIR` and `METATOR_STATE_DIR` move these two directories.

## Print a schema

Most kinds have a command that prints their JSON Schema:

```bash
metator config schema          metator rules schema         metator patterns schema
metator memory schema          metator workflow schema      metator plan schema
metator findings schema        metator eval schema          metator env schema
metator system schema          metator system plan schema   metator system eval schema
metator arch schema            metator arch plan schema     metator arch eval schema
metator docs schema     metator meta schema agents   metator meta schema skills
metator run schema <artifact>
```

`<artifact>` is one of `analysis`, `research`, `plan`, `plan-scope`, `review-plan`, `pr`, `findings`, `verdict`, `summary`.

In the MetatorAI repository, the schema of every released version is also a file: `docs/metator/schemas/<Kind>.v<N>.json`. A released version never changes. A change to a document is a new version with a migration from the previous one.
