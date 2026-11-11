# Change across applications

The `mt-system-change` workflow carries out a task that changes more than one application: a contract that others consume, or a feature that spans a service and its frontends. It plans one step per application, in deploy order, and runs each step as its own run in that application's repository.

You need a system map first. See [Systems of applications](../repo/systems.md). For a change inside one application, use [Feature](./feature.md).

## Start

In the repository that holds the system map:

```text
@mt-orchestrator run mt-system-change for: Rename refunds to credit notes in the billing API.
```

```bash
metator run init --workflow mt-system-change --task "Rename refunds to credit notes in the billing API"
metator run drive --detach
```

<WorkflowDiagram id="mt-system-change" />

## Stages

| Stage | Who | What happens |
|---|---|---|
| `analyze` | `mt-system-scout` | `metator system analyze <task>`: the contracts the task touches, whether each change is breaking, their consumers and owners |
| `plan` | `mt-system-planner` | `metator system plan new <task>` drafts a plan by the map's policies; the planner refines it into one step per application |
| `plan-gate` | `metator system plan lint` | every consumer of a breaking change migrates, providers go first, the strategy matches the map's policy |
| `plan-approval` | you | approve the system plan, then the gate |
| `children` | `metator system plan run` | each step that can start becomes a child run in its application's repository |
| `status` | `metator system status --check` | the child runs are read back; when a wave is done, the next one starts |
| `delivery` | you | every step is done; deploy in the order of the plan's waves |

Neither approval can be skipped at any autonomy level.

## Approve the plan

```bash
metator system plan approve rename-refunds --by alice
metator run approve plan-approval --by alice
```

The first command approves the system plan itself. The second passes the run's gate.

## Child runs

Each step runs where its application's code is, as an `mt-feature` run with that repository's own gates, rules and approvals. You answer a child run's questions like those of any run. They are in the same [inbox](./inbox.md) when the repositories are in one folder.

A step can run only in a checkout you work in: this repository, or a checkout named for the application under `system.roots` in `metator.config.yml`. A step whose application has no checkout stops with a hint.

The runs point at each other:

| Link | Where |
|---|---|
| child to parent | the child's `state.json`: `parent` and `system` (plan, step, application) |
| parent to children | the system run's `state.json`: `children`, and a line in its `log.md` |
| step to run | the step's `run` in the system plan |

## Follow the steps

```bash
metator system status rename-refunds
```

It lists every step with its application, its status (`pending`, `running`, `done` or `blocked`), its child run and that run's stage.

A child run that escalates or is aborted makes its step `blocked`. Resolve it in that repository, then check the status again.

## Done

- the system plan lints clean and a person approved it;
- every step's child run is done in its repository;
- the contract check passes in every provider's repository. An approved plan lets a planned breaking step through once the steps before it are done.
