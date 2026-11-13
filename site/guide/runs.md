# Runs and workflows

A run is one task carried through a workflow. This page explains what a workflow defines, how a run moves, what it leaves on disk, and how to stop and continue one.

## Workflows

A workflow is a YAML file in `.github/metator/workflows/`. It lists the stages in order. For each stage it says who does the work (an agent, a skill or a script), which file the stage must produce, what check closes it, and where a failure goes back to.

The `metator` CLI reads the workflow, not the model. The stage order, the retry limits and the approvals hold whether or not an agent remembers them.

Seven workflows are shipped:

| Id | Use it to |
|---|---|
| `mt-feature` | build a feature: survey, plan, build, check, review, push |
| `mt-bugfix` | fix a bug behind a regression test that reproduces it first |
| `mt-refactor` | change structure in small steps and prove behavior did not change |
| `mt-pr-review` | review a pull request and publish comments after approval |
| `mt-self-review` | review your own branch and fix what blocks, without pushing |
| `mt-review-response` | answer the review threads on your own pull request |
| `mt-system-change` | carry one change through several applications as child runs |

```bash
metator workflow list        # the installed workflows and their stages
metator workflow lint        # check every spec after you edit one
```

You can edit a workflow or add your own. `metator agents update` keeps the files you changed.

## What must hold before a run starts

A workflow lists its `preconditions`. `metator run init` checks each one when the run starts and refuses with the precondition's name and the step that fixes it.

| Precondition | Holds when | When it does not |
|---|---|---|
| `clean-tree` | no tracked file has uncommitted changes | commit or stash them, or pass `--allow-dirty` |
| `branch-ok` | the checkout is on a branch, or the run works in a worktree | `git switch -c <branch>`, or pass `--worktree` |
| `tests-green` | the quick gate passes; the run starts only after it ran | `metator gate quick` shows the failing steps |

`mt-feature`, `mt-bugfix` and `mt-system-change` require `clean-tree` and `branch-ok`. `mt-refactor` also requires `tests-green`, so starting a refactor takes as long as your quick gate, and it refuses when `gates.quick` has no steps. The review workflows require nothing.

These three are the whole list. `metator workflow lint` rejects any other name, and a run does not start on a precondition that nothing can check. If you installed the workflows before this list existed, run `metator setup` again: the older files name `index-fresh`, which is gone.

## How a run moves

A run is at exactly one stage. It moves only when the CLI receives an event for that stage:

```bash
metator run init --workflow mt-feature --task "Add combined discount"   # a new run at the first stage
metator run status                                                      # the stage and the events it accepts
metator run advance pass                                                # the stage is done
metator run advance fail --reason "gates: 2 tests red"                  # the stage failed
metator run approve plan-approval --by alice                            # a stage that waits for a person
```

Agents send these commands during a run. Three things follow from the workflow and cannot be talked around:

- A stage accepts only the events it expects. A stage that waits for a person accepts `approve`, never `pass`.
- A failed stage goes back to the stage the workflow names. In `mt-feature`, failed gates go back to `build`.
- Each way back has a limit (`loops` in the workflow; `mt-feature` allows two returns to `build`). When the limit is used up, or a stage fails that has no way back, the run is escalated.

An escalated run stops and waits for you. `metator run status` and `metator inbox` show the stage it stopped at, the reason, and the two commands that get it out. `metator run drive` and `metator run continue` refuse an escalated run and name the resume.

When you have fixed the cause, put the run back at the stage it stopped at. With `--drive` it is driven on at once:

```bash
metator run resume --drive
```

`--by` says who resumed the run. Without it the name comes from `$METATOR_USER`, or else from `git config user.name`. The same holds for `run approve`, `run advance approve`, `run answer`, `run message`, `mrs send`, `mrs resolve`, `findings react` and `review notes add` and `send`. The name only says who acts: the command is still the decision, and a command with no name anywhere is refused.

A resumed run gets a fresh set of tries for the stage it stopped at: if the stage fails again, the run goes back to be fixed as the workflow says, and escalates only when that limit is used up again. The first agent that runs after a resume is told why the stage failed.

To send the run back further, name the stage with `--to`, and say why with `--note`:

```bash
metator run resume --to plan --note "split step 2; the check needs the file it names" --drive
```

`--to` takes a stage the run already worked, or the stage it escalated from. Any other stage is refused, and the error names the stages you can choose. Sent back to an earlier stage, every loop of the run counts from zero, and the approvals on the way are asked again. The first agent that works after the resume reads your note and the failure the run escalated on. The run keeps the resume: `metator run status` shows it until an agent has worked, and the log, the activity and the plan board (`metator run board`) keep it for good.

To give the run up instead, close it with a reason (see [Finish a run](#finish-a-run)).

## What a run leaves on disk

Each run has a directory, `.metator/runs/<run id>/`. It is not committed.

| File | What |
|---|---|
| `state.json` | the stage, the loops used and the approvals; written only by `metator run` |
| `log.md` | every transition and approval, in order, append-only |
| `activity.jsonl` | one event per line when the run is driven: agents, tools, questions, answers |
| `questions/` | the questions the run asked you, and your answers |
| `task.md`, `plan.json`, `gates.md`, `verdict.json`, … | the file each stage produced |
| `summary.json` | written by `metator run close`: duration, events, loops, approvals |

A log looks like this:

```text
- 2026-11-11T01:40:35.736Z · plan-gate · PASS → plan-approval
- 2026-11-11T01:40:38.065Z · plan-approval · APPROVE · by alice → build
- 2026-11-11T01:40:55.775Z · build · PASS → gates
- 2026-11-11T01:40:56.678Z · gates · FAIL · 2 tests red → build
```

Because the state is in files, a run does not depend on a chat. `metator run status` tells any new session where the run is, and `metator run handoff` writes `handoff.md` for a colleague who takes it over.

## Drive a run from the terminal

In a chat, the `mt-orchestrator` agent moves the run. From a terminal, MetatorAI can do it: it starts each stage's agent through your AI tool and asks you when a stage needs a decision.

```bash
metator run drive --host claude --detach     # drive the latest run in the background
metator inbox                                # the questions waiting for you, across all runs
metator run answer q001 --choice Approve --by alice
metator run stop                             # stop driving; the run stays where it is
metator run continue                         # drive it again
```

A run has one driver at a time. A second `run drive` is refused while the first is alive.

`run drive` checks the host before it runs a stage. A host whose program is not installed is refused with the hosts that are, so no stage fails for that reason. If a run's worktree was removed by hand, the drive stops and names the two ways on: put the worktree back, or close the run.

You can also approve a gate with `metator run approve <stage>` while a drive waits on its question. The drive notices that the run moved on and carries on with the next stage.

## Run several tasks at once

Give a run its own git worktree and it does not touch your checkout or another run's files:

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
```

`metator status` lists every run and which ones wait for you. `metator ui` shows the same as a full-screen view. See [Sessions and worktrees](../use/sessions.md).

## Finish a run

```bash
metator run close                                  # a finished run: writes summary.json
metator run close --aborted --reason "superseded"  # give up an active or an escalated run
```

`run close` refuses an active run without `--aborted` and a reason. With them, the run ends as aborted, the process that drives it is stopped, and its open questions leave the inbox. An escalated run closed without `--aborted` keeps its status and can still be resumed.
