# Full runs

A full run is one task carried through a workflow: stages in a fixed order, each checked by a command, a second agent or you. This page covers the workflows, how to start a run, how it moves, what it leaves on disk, and how to stop, continue and close it.

## Workflows

A workflow is a YAML file in `.github/metator/workflows/`. It lists the stages in order, and for each who does the work (an agent, a skill or a script), which file it must produce, what check closes it, and where a failure goes back to. The `metator` command reads the workflow, not the model: the stage order, the retry limits and the approvals hold whether or not an agent remembers them.

Eight workflows are shipped:

| Workflow | Use it to |
|---|---|
| [`mt-feature`](./feature.md) | build a feature: survey, plan, build, check, review, deliver |
| [`mt-bugfix`](./bugfix.md) | fix a bug behind a regression test that reproduces it first |
| [`mt-refactor`](./refactor.md) | change structure in small steps and prove behavior did not change |
| [`mt-quick`](./quick.md) | make a small change without a plan; started with `metator quick start`, it ends with a diff to look at |
| [`mt-pr-review`](./review.md) | review a pull request and publish the comments after your approval |
| [`mt-self-review`](./review.md#self-review) | review your own branch and fix what blocks, without pushing |
| [`mt-review-response`](./reviews.md#your-own-pull-requests) | answer the review threads on your own pull request |
| [`mt-system-change`](../many/plans.md) | carry one change through several applications as child runs |

```bash
metator workflow list        # the installed workflows and their stages
metator workflow lint        # check every spec after you edit one
```

You can edit a workflow or add your own. `metator agents update` keeps the files you changed.

## Start a run

### From a chat

Ask for the change. When it is not quick, the agent names the workflow and why, asks what the repository cannot tell it (the autonomy, whether the run gets its own worktree, in a folder which repository), with the recommended answer first, and starts the run with `metator run new` and `metator run start`. The run's conductor opens in its own terminal ([Chats and the three ways](./start.md)).

### From the form

**Form…**, next to **+ New chat**, opens a form instead of a conversation. A run started from it belongs to no chat: the sidebar lists it under **Without a chat**.

| Field | What you choose |
|---|---|
| **Repository** | which repository the run belongs to; only when the daemon serves a folder of repositories |
| **Workflow** | one of the repository's workflows, `mt-feature` to begin with |
| **Task** | what to do, in one or two sentences |
| **AI host** | the host whose agents work on the run: the first installed one of `supervisor.hostOrder` is chosen, one that is not installed is greyed out; or **create only, start the agent later** |
| **Autonomy** | the levels the workflow runs at, for example **L0: every approval waits for you** ([Autonomy](./approvals.md#autonomy)) |
| **Worktree** | a worktree with its own ports (ticked by default), or the main checkout |
| **Parent run** | an active run this one is a step of, or **none (standalone)** |

The bottom line shows the `metator run new` command your choices amount to. **Create in background** starts the run and leaves you where you are; **Create and attach** opens its **Terminal** tab and gives you its keyboard. When as many runs already wait for you as `supervisor.wipLimit` allows (default 4), the form warns that the new one queues behind them.

### From the backlog

**Implement** on an open task of the **Backlog** starts a run with the task's title and text, and its plan when it has one ([Plan and backlog](./plan.md#backlog)).

### From a terminal

```bash
metator run
```

This asks for the workflow, the task, the autonomy level, the AI host (only the installed ones) and whether the run gets its own worktree, then drives the run in the background and shows it live. Ctrl+C leaves the view; the run goes on and waits for you. `metator run continue` picks a run that waits for you or stopped and shows it again.

In a script or in CI, use the commands the prompt is made of:

```bash
metator run new --workflow mt-feature --task "Add combined discount" --worktree
metator run start                         # its conductor in a pane under the daemon, which you can watch
metator run drive --host claude --detach  # or: without a terminal, stage by stage
```

## What must hold before a run starts

A workflow lists its `preconditions`. `metator run new` checks each one and refuses with its name and the fix.

| Precondition | Holds when | When it does not |
|---|---|---|
| `clean-tree` | no tracked file has uncommitted changes | commit or stash them, or pass `--allow-dirty` |
| `branch-ok` | the checkout is on a branch, or the run works in a worktree | `git switch -c <branch>`, or pass `--worktree` |
| `tests-green` | the quick gate passes; the run starts only after it ran | `metator gate quick` shows the failing steps |

`mt-feature`, `mt-bugfix` and `mt-system-change` require `clean-tree` and `branch-ok`. `mt-refactor` also requires `tests-green`, and refuses when `gates.quick` has no steps. `mt-quick` and the review workflows require nothing.

A run in its own worktree starts from the last commit: when tracked files have uncommitted changes, `run new --worktree` refuses and names them; `--allow-dirty` starts without them (in the app: **Start from the last commit**). A run in your checkout with `--allow-dirty` takes them into its change.

## How a run moves

A run is at exactly one stage. It moves only when the command receives an event for that stage:

```bash
metator run status                                      # the stage and the events it accepts
metator run advance pass                                # the stage is done
metator run advance fail --reason "gates: 2 tests red"  # the stage failed
metator run approve plan-approval                       # a stage that waits for a person
```

Agents send these during a run. Three things follow from the workflow and cannot be talked around:

- A stage accepts only the events it expects. A stage that waits for a person accepts `approve`, never `pass`.
- A failed stage goes back to the stage the workflow names. In `mt-feature`, failed gates go back to `build`.
- Each way back has a limit (`loops`; `mt-feature` allows two returns to `build`). When it is used up, or a stage fails that has no way back, the run is **escalated**.

An escalated run stops and waits for you. Its card on Home says why, with **Resume** and **Close run…**. Remove the cause, then resume: the run goes back to the stage it stopped at with a fresh set of tries, and the first agent after the resume is told why the stage failed.

```bash
metator run resume --run <id> --drive
metator run close --run <id> --aborted --reason "not worth fixing"
```

To send the run back further, name the stage with `--to`, and say why with `--note`:

```bash
metator run resume --run <id> --to plan --note "split step 2; the check needs the file it names" --drive
```

`--to` takes a stage the run already worked, or the stage it escalated from. Any other stage is refused, and the error names the stages you can choose. Sent back to an earlier stage, every loop of the run counts from zero, and the approvals on the way are asked again. The first agent that works after the resume reads your note and the failure the run escalated on. The run keeps the resume (RunRecord v8, `resumes`): `metator run status` shows it until an agent has worked, and the log, the activity and the plan board (`metator run board`) keep it for good.

`--by` says who acts. Without it the name comes from `$METATOR_USER`, else from `git config user.name`, else from your login name. A decision (`run approve`, `run advance approve`, `mrs send`, `mrs resolve`) never takes the login name: without `--by`, `$METATOR_USER` or git's `user.name` it is refused. An empty `--by` is always refused, and an approval relayed from the chat (`--via chat`) always names the person. The name only says who acts: the command is still the decision.

## Who moves a run

| How it was started | Who moves it |
|---|---|
| from a chat, or `metator run start` | the run's conductor, `mt-orchestrator`, in a terminal of its own; it starts each stage's worker in another pane ([Terminals and sessions](./sessions.md#agents-in-panes)) |
| `metator run drive`, **Drive in background** | MetatorAI itself, without a terminal: it starts each stage's agent through your host and asks you at each approval |

A run has one driver at a time; a second `run drive` is refused while the first is alive. A run nothing moves reads `blocked` with `nothing drives it`, and its page offers **Open a session** and **Drive in background**.

```bash
metator run drive --host claude --detach     # drive the latest run in the background
metator run stop                             # stop driving; the run stays where it is
metator run continue                         # drive it again and watch
metator run revive                           # restart every drive that died (a reboot, a killed process)
```

`run drive` checks the host before it runs a stage: a host that is not installed is refused with the hosts that are. When a run's worktree was removed by hand, the drive stops with `the worktree of run <id> is gone`: put it back (`git worktree prune && git worktree add <path> <branch>`), or close the run.

## What a run leaves on disk

Each run has a directory, `.metator/runs/<run id>/`. It is not committed.

| File | What |
|---|---|
| `state.json` | the stage, the loops used and the approvals; written only by `metator run` |
| `log.md` | every transition, approval and checkpoint, in order, append-only |
| `activity.jsonl` | one event per line: stages, agents, tool calls, questions, answers, gates |
| `questions/` | the questions the run asked you, and your answers |
| `task.md`, `plan.json`, `plan-scope.json` | the task, the plan, and the files the build may edit |
| `gates.md`, `findings/`, `verdict.json`, … | the file each later stage produced |
| `summary.json` | written by `metator run close`: duration, events, loops, approvals |

A log looks like this:

```text
- 2026-11-11T01:40:35.736Z · plan-gate · PASS → plan-approval
- 2026-11-11T01:40:38.065Z · plan-approval · APPROVE · by alice → build
- 2026-11-11T01:40:55.775Z · build · PASS → gates
- 2026-11-11T01:40:56.678Z · gates · FAIL · 2 tests red → build
```

Because the state is in files, a run does not depend on a chat. `metator run status` tells any new session where the run is, and `metator run handoff` writes `handoff.md` for a colleague who takes it over.

## Finish a run

After you approve the delivery of `mt-feature`, `mt-bugfix` or `mt-refactor`, the run commits its change and pushes its branch, `metator/<run id>`, to `origin`; it opens a pull request only when the task asked for one.

```bash
metator run close                                  # a finished run: writes summary.json
metator run close --remove-worktree                # also remove its worktree and free its ports
metator run close --aborted --reason "superseded"  # give up an active or an escalated run
```

`run close` refuses an active run without `--aborted` and a reason. With them, the run ends as aborted, the process that drives it is stopped, and its open questions leave Home. An escalated run closed without `--aborted` keeps its status and can still be resumed. Worktrees are on [Terminals and sessions](./sessions.md#worktrees).
