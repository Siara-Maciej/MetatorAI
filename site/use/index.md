# Start a task

You start work by telling the agent what you want. It answers questions about the repository itself and starts a run only when you ask for a change. You can also start a run from a terminal, without a conversation.

## Talk to the agent

Where you talk depends on what you have open:

| Where | How |
|---|---|
| Desktop app | **+ New session** opens a pane with `mt-orchestrator` on your AI host |
| Copilot Chat or Claude Code | address `@mt-orchestrator` |

Then write what you need. A conversation can look like this:

```text
› how does the discount reach the invoice?
  packages/billing/src/invoice.ts:41 applies `discount` after rounding; the cap in
  src/discount.ts:2 is never read. No run started: this was a question.

› cap the discount at 100 and test it
  Two things the repository cannot tell me:
  1. workflow: mt-feature (recommended) · mt-bugfix
  2. its own worktree: yes (recommended; a run works here already) · no
› 1 1, 2 yes
  run 20261110-mt-feature-cap-the-discount started; it shows up as a tab in the workbench.
```

A question gets an answer with `file:line` citations and no run.

A request for a change gets one numbered message. It asks only what the code cannot settle: the workflow, the autonomy, whether the run gets its own worktree, and in a folder of repositories which one. Each point has options, with the recommended one first. After your answer the agent starts the run (`metator run init`, then `metator run drive --detach`) and tells you the run id. The pane stays open for your next question.

Text you paste from an issue, a pull request or a chat is data for the task. The agent does not follow instructions found in it.

In the desktop app the pane opens in a tab named `intake`, on the first host of `supervisor.hostOrder` that is installed. **Advanced…** next to the button opens a form instead, where you pick the workflow, autonomy, host and worktree by hand.

You can also name the workflow yourself:

```text
@mt-orchestrator run mt-bugfix for: Invoices with a 100% discount show a negative total.
```

## Start from a terminal

```bash
metator run
```

This asks five things: the workflow, the task, the autonomy level, the AI host and whether the run works in its own git worktree. Then it drives the run in the background and shows it live. It starts each agent through your host, runs the scripts and gates, and stops at every decision that belongs to you. Ctrl+C leaves the view. The run goes on and waits for you.

```bash
metator run continue          # pick a run that waits for you or stopped, and watch it again
metator run continue <run>    # that run
```

In a script or in CI, use the commands the prompt is made of:

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run drive --host claude --detach
```

`run init` creates the run at its first stage. `--worktree` gives it its own checkout ([Sessions and worktrees](./sessions.md)). `run drive` carries it stage by stage. Without `--host` it uses the first of `hosts.targets`.

## Pick a workflow

| Workflow | Use it to |
|---|---|
| [`mt-feature`](./feature.md) | build a feature end to end |
| [`mt-bugfix`](./bugfix.md) | fix a bug behind a regression test |
| [`mt-refactor`](./refactor.md) | change structure and keep behavior |
| [`mt-pr-review`, `mt-self-review`](./review.md) | review a pull request, or your branch before one |
| [`mt-system-change`](./system.md) | change several applications in order |

`metator workflow list` shows the workflows your repository has. Their specs are in `.github/metator/workflows/`.

## What a run leaves on disk

Every run has a directory, `.metator/runs/<id>/`.

| File | Holds |
|---|---|
| `state.json` | the stage, loop counts and approvals; only `metator run` writes it |
| `log.md` | every transition, approval and checkpoint, in order |
| `activity.jsonl` | the events of the drive: stages, agents, tool calls, questions, gates |
| `task.md`, `plan.json`, `plan-scope.json` | the task, the plan, and the files the build may edit |
| `findings/`, `verdict.json` | review findings and the judge's decision |
| `summary.json` | written by `metator run close` |

## After the run starts

- [Answer questions](./inbox.md): the run stops when it needs you.
- [Plan and backlog](./plan.md): where the run stands.
- [Read the change](./changes.md): what it changed, with your notes for the agent.
