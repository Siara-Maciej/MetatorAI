# System change (W13 `mt-system-change`)

**Use it when** a task changes more than one application: a contract others consume, or a feature that spans a service and its frontends, often in separate repositories.

## Start

```text
@mt-orchestrator run mt-system-change: Rename refunds to credit notes in the billing API.
```

or from the terminal, in the repository that holds the [system map](../multi-repo/index.md):

```bash
metator run init --workflow mt-system-change --task "Rename refunds"
```

<WorkflowDiagram id="mt-system-change" />

## What happens

| Stage | Who | What |
|---|---|---|
| analyze | `mt-system-scout` | `metator system analyze <task>`: the contracts the task touches, breaking or not, their consumers and owners |
| plan | `mt-system-planner` | `metator system plan new <task>`: a draft by the map's policies, refined: one step per application, in deploy order |
| plan-gate | `metator system plan lint --run {runDir}` | every consumer of a breaking change migrates, providers go first, the strategy matches the policy |
| plan-approval | you | `metator system plan approve <id>`, then this gate |
| children | `metator system plan run --run {runDir}` | each step that can start becomes a child run (W1) in its application's repository |
| status | `metator system status --run {runDir} --check` | the child runs read back; the next wave starts when this one is done |
| delivery | you | every step done; deploy in the plan's waves |

## Child runs

Each step runs where its application's code is, with that repository's own gates, rules and approvals:

```bash
metator system plan run --run 20261029-mt-system-change-rename-refunds
```

```json
{"started":[{"step":"billing-bump","app":"billing","root":"/src/billing",
  "run":"20261029-mt-feature-release-a-new-major-version-of-billing-api",
  "task":"Release a new major version of billing-api (system plan rename-refunds, step billing-bump in billing; contracts: bump billing-api. Task: Rename refunds)"}]}
```

| Link | Where |
|---|---|
| child → parent | the child's `state.json`: `parent` and `system: { plan, step, app }` |
| parent → children | the system run's `state.json`: `children`, and a `child` line in its `log.md` |
| step → run | the step's `run` in the system plan |

A step runs only in a checkout you work in: this repository (its `path` applications) or one set in `system.roots`. Clones in `.metator/system/` are read-only, so a step whose application has no checkout stops with a hint.

```bash
metator system status rename-refunds
```

```json
{"steps":[
  {"id":"billing-bump","app":"billing","status":"done","run":"20261029-mt-feature-…","runStatus":"done","root":"/src/billing"},
  {"id":"web-migrate","app":"web","status":"running","run":"20261029-mt-feature-…","runStatus":"active","stage":"build","root":"/src/web"}]}
```

A child run that escalates or is aborted makes its step `blocked`: resolve it in that repository, then check again.

## Done means

- the system plan lints clean and a person approved it;
- every step's child run is done in its repository;
- `contract diff` passes in every provider's repository. An approved plan lets the planned breaking step through once the steps before it are done.
