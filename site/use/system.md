# Change across applications

The `mt-system-change` workflow carries out a task that changes more than one application: a contract that others consume, or a feature that spans a service and its frontends. It plans one step per application, in deploy order, and runs each step as its own run in that application's repository.

You need a system map first. See [Systems of applications](../repo/systems.md). For a change inside one application, use [Feature](./feature.md).

## Start

In the repository that holds the system map:

```text
@mt-orchestrator run mt-system-change for: Rename refunds to credit notes in the billing API.
```

```bash
metator run new --workflow mt-system-change --task "Rename refunds to credit notes in the billing API"
metator run drive --detach
```

<WorkflowDiagram id="mt-system-change" />

## Stages

| Stage | Who | What happens |
|---|---|---|
| `analyze` | `mt-system-scout` | `metator system analyze <task>`: the contracts the task touches, whether each change is breaking, their consumers and owners |
| `plan` | `mt-system-planner` | `metator system plan new <task>` drafts a plan by the map's policies; the planner refines it into one step per application |
| `plan-gate` | `metator system plan lint` | every consumer of a breaking change migrates, providers go first, the strategy matches the map's policy |
| `plan-approval` | you | one **Approve** approves the system plan and the gate; asking for changes sends the plan back to `mt-system-planner` with your words |
| `children` | `metator system plan run` | each step that can start becomes a child run in its application's repository, driven at once on the system run's host |
| `status` | `metator system plan status --gate` | waits while the child runs work (also while one waits for you), starts the next wave itself when one is done (a wait, not a failure: no loop is spent), and stops when a child is closed as aborted |
| `delivery` | you | every step is done; deploy in the order of the plan's waves |

Neither approval can be skipped at any autonomy level.

## Approve the plan

Approve the plan-approval card in the app, or at a terminal:

```bash
metator run approve plan-approval --by alice
```

One approval does both: it approves the system plan as it is now, under your name, and passes the run's gate. When the plan's lint has errors (someone changed the plan after its lint passed), the approval is refused with the problems, and the card's **Approve** is disabled with the reason. `metator system plan approve <plan>` still approves the plan on its own.

### In the app

**System** lists the system plans with their status and steps done. A plan shows its steps per repository, the waves (the deploy order), the lint and who approved it. You can change it there:

- add, remove or reorder steps, change a step's summary, contracts or dependencies; the waves and the lint follow as you type;
- a step that already has a child run cannot be changed or removed; add a new step instead;
- changing an approved plan sends it back to draft: the approval is shown as stale and someone approves it again (**Approve** refuses a plan whose lint has errors);
- if someone saved the plan since you opened it, your save is refused and the app shows the plan as it is now.

Every change is a line of the plan's edit log, `metator/system/plans/<id>.edits.jsonl`, with who made it and what changed.

The **System map** screen shows `docs/metator/system.yml` with its lint and lets you change it the same way (a map pinned in another repository is changed there). **Discover** proposes a map from the code of this repository, or of every repository of the folder; it writes the map only when there is none. With no map yet, everything it found is listed as what the map lacks, and **Write** creates the map. A map written in a folder names the repository that holds it as `path: .` and the others beside it as `../<name>`. At a terminal in a folder, `metator system discover --write` writes the folder's map into the repository that holds it (`--repo <name>`; by default the one that has a map, else the first). The checkouts of the applications come from the option `system.roots`: the directories on this machine that hold them (`metator config set system.roots ~/code --scope repo`, or **Save roots** in the app). An application is found in `<directory>/<its id>` or `<directory>/<its repository's name>`.

## Child runs

Each step runs where its application's code is, as an `mt-feature` run with that repository's own gates, rules and approvals. It is driven as soon as it starts: on the system run's host, else the first host of `supervisor.hostOrder` that can start there. A child in its own worktree gets its dependencies first. Nobody has to open a session for it. You answer a child run's questions like those of any run. They are in the same [inbox](./inbox.md) when the repositories are in one folder.

A step can run only in a checkout you work in: this repository, or a checkout named for the application under `system.roots` in `metator.config.yml`. A step whose application has no checkout stops with a hint.

The runs point at each other:

| Link | Where |
|---|---|
| child to parent | the child's `state.json`: `parent` and `system` (plan, step, application) |
| parent to children | the system run's `state.json`: `children`, and a line in its `log.md` |
| step to run | the step's `run` in the system plan |

## Follow the steps

```bash
metator system plan status rename-refunds
```

It lists every step with its application, its status (`pending`, `running`, `done` or `blocked`), its child run and that run's stage.

While its children work, the system run waits at `status` without spending its waves, and reads as working: its activity says what it waits on, for example `waiting on children: shop-api working at build, shop-web not started`. When a wave is done, the next one starts. A child run that escalates does not stop the system run: it waits, and reads `blocked by <child run> (<app>, at <stage>): needs you`. Act on the child's own card (resume it, or close it); once the child is resumed, the system run goes on by itself. A child closed as aborted blocks its step for good: the system run escalates, naming the step. It also escalates after waiting six hours (`--timeout <ms>` on the gate's `metator system plan status --gate` changes that).

## Done

- the system plan lints clean and a person approved it;
- every step's child run is done in its repository;
- the contract check passes in every provider's repository. An approved plan lets a planned breaking step through once the steps before it are done.
