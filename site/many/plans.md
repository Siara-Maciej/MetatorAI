# System plans

A system plan carries one change through several applications: a contract that others consume, or a feature that spans a service and its frontends. It has one step per application, in deploy order, and each step runs as its own run in that application's repository, with that repository's gates, rules and approvals. No agent edits several repositories in one session.

You need a [system map](./systems.md) first. For a change inside one application, use a [full run](../use/runs.md).

## Start

In a chat in the repository that holds the system map, ask for the change; the agent suggests `mt-system-change` when it reaches other applications (`metator quick check` calls that `cross-repository`, which is never quick). From a terminal:

```bash
metator run new --workflow mt-system-change --task "Rename refunds to credit notes in the billing API"
metator run start
```

<WorkflowDiagram id="mt-system-change" />

| Stage | Who | What happens |
|---|---|---|
| `analyze` | `mt-system-scout` | `metator system analyze <task>`: the contracts the task touches, whether each change is breaking, their consumers and owners |
| `plan` | `mt-system-planner` | `metator system plan new <task>` drafts a plan by the map's policies; the planner refines it into one step per application |
| `plan-gate` | `metator system plan lint` | every consumer of a breaking change migrates, providers go first, the strategy matches the map's policy |
| `plan-approval` | you | one **Approve** approves the system plan and the gate; **Ask for changes** sends the plan back to `mt-system-planner` with your words |
| `children` | `metator system plan run` | each step that can start becomes a child run in its application's repository, opened at once as its own conductor session |
| `status` | `metator system plan status --gate` | waits while the child runs work (also while one waits for you), starts the next wave itself when one is done, and stops when a child is closed as aborted |
| `delivery` | you | every step is done; deploy in the order of the plan's waves |

Neither approval can be skipped at any autonomy level.

## The plan

Under `expand-contract`, a breaking change to `billing-api` drafts three waves:

| Wave | Step | Repository | What it does |
|---|---|---|---|
| 1 | `billing-expand` | billing | add the new shape of `billing-api` beside the old one |
| 2 | `web-migrate`, `mail-migrate` | web, mail | move each consumer to the new shape |
| 3 | `billing-contract` | billing | remove the old shape |

Under `versioned` the draft is a `bump` step (a new major version) and a `migrate` step for each consumer.

The same plan without the workflow, from a terminal:

```bash
metator system analyze Rename refunds --breaking billing-api   # what the task touches
metator system plan new Rename refunds                          # a draft from the map's policies
metator system plan propose Rename refunds --host claude        # or: the system agents check the analysis and refine it
metator system plan lint rename-refunds
metator system plan approve rename-refunds                      # you, never an agent
```

`system plan lint` reports an error when:

- a consumer of a breaking change has no `migrate` step;
- a consumer migrates before the provider expands, or the old shape is removed before every consumer migrated;
- a breaking change has no strategy, or one the map's policy does not allow;
- a step names an application or contract the map does not have;
- a step changed after you approved the plan.

Once the plan is approved, `contract diff --check` lets the breaking change through in the provider's repository, only for the step that makes it and only after the steps before it are done.

## Approve the plan

The plan-approval card on Home shows the plan's flow, with its steps per repository folded under it (**6 steps in 3 repositories**), and **Approve** and **Ask for changes** above it. One approval does both: it approves the system plan as it is now, under your name, and passes the run's gate. While the plan's lint has errors, **Approve** is closed with the reason. At a terminal:

```bash
metator run approve plan-approval --by alice
```

A plan is never edited by hand in the app: the app shows system plans read-only, and a plan changes only through its planner, with your words on **Ask for changes**. When the planner has written a new version, the card shows **Changed since the previous plan**.

## In the app

The system run's page is the task's page. Its **Overview** has the one thing to decide in the task, then the plan's flow: a column per wave, a lane per repository, one node per step (dashed while it has not started, with what it waits for), an arrow from each step to the steps that wait for it, and the critical path drawn heavier ([A system run's plan](../use/plan.md#a-system-runs-plan)).

![A system task's page: the plan's flow, a lane per repository and a node per step](../public/screens/system-plan.png)

- A click on a step opens its detail. **Plan this step** asks for that step's own plan now, in its repository, before the whole task runs ([A step's detail](../use/plan.md#a-steps-detail)); `metator system plan step-plan <plan> <step>` does the same.
- **Create Backlog item** puts the plan in the Backlog without running it, one part per step ([Plans in the Backlog](../use/plan.md#plans-in-the-backlog)).
- The **Board** puts the task in its phase, and a click opens the task's own board with its steps across repositories ([The Board](../use/inbox.md#the-board)).
- **Settings › System › System** lists the system plans; **Dependencies** draws the runs as lanes ([Settings › System](../use/settings.md#system)).

## Child runs

Each step runs where its application's code is, as an `mt-feature` run. It opens as soon as it starts as a conductor session of its own, a terminal in **Terminals**: on the system run's host when that is an interactive host installed here, else the first installed host of `supervisor.hostOrder`. Its conductor starts its workers in panes of their own. The session needs the daemon of that repository or its folder. With no daemon, or no interactive host, the child is driven in the background instead, and says why: `metator system plan run` prints each step with `session in pane w1:p1 on claude` or `driven in the background on claude: no daemon runs for this repository`.

![Terminals for a system task: the chat, the shop-api session, its finished step, and the shop-web step working](../public/screens/real/real-09-system-task-tiles.webp)
*A system task: one session per repository, each a tile beside the chat.*

Every child works on a branch of its own (`metator/<worktree>`) in a worktree of its own, made from the repository's HEAD (or `--base`), so its agents never commit on the default branch and two steps of one repository never share a checkout. You answer a child run's questions like those of any run; they are on the same Home when the repositories are in one folder.

A step can run only in a checkout on this machine: this repository, or a checkout named for the application under `system.roots` in `metator.config.yml` (`metator config set system.roots ~/code --scope repo`, or **Save roots** in the app). An application is found in `<directory>/<its id>` or `<directory>/<its repository's name>`. A step whose application has no checkout stops with a hint.

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

While its children work, the system run waits at `status` and reads as working: its activity says what it waits on, for example `waiting on children: shop-api working at build, shop-web not started`. When a wave is done, the next one starts. A child run that escalates does not stop the system run: it waits, and reads `blocked by <child run> (<app>, at <stage>): needs you`. Act on the child's own card (resume it, or close it). A child closed as aborted blocks its step: the system run escalates, naming the step. It also escalates after waiting six hours (`--timeout <ms>` on the gate's `metator system plan status --gate`).

A step whose child run was closed as aborted can be tried again: **Retry this step** on the system run's bar (and on the step in its plan), or `metator system plan retry <plan> <step> --by <name>`. The step is pending again, with the old run in its `previousRuns`, and the old run's worktree is left for you to look at. Resume the system run, or let it go on waiting: it starts a new child for the step in a fresh worktree.

## Done

- the system plan lints clean and a person approved it;
- every step's child run is done in its repository;
- the contract check passes in every provider's repository.
