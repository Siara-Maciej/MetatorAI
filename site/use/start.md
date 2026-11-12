# Start a task

You start work by telling the agent what you want. It answers questions about the repository itself and starts a run only when you ask for a change. This page shows how to do that in the app, in your AI tool's chat, and from a terminal.

## In the app

Click **+ New session** at the bottom of the runs panel, or press `n`. The app opens the **Work** screen with a new tab named `chat`, the conversation in which you say what you want. Its pane runs the agent `mt-orchestrator` on your AI host: the first host of the option `supervisor.hostOrder` that is installed on the daemon's machine.

When no host is installed, no tab opens. The app says so at the top of the screen, names the programs the daemon looked for, and points to the guide page [Copilot and Claude Code](../guide/hosts.md). Install one and click **+ New session** again; the daemon needs no restart.

If the host's program starts and exits at once, for example because you are not logged in, the pane stays with its last output and a line such as "The process ended with code 3." **Retry** starts it again and **Close tab** removes the tab.

Write what you need in the pane. A conversation can look like this:

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

A request for a change gets one numbered message. It asks only what the code cannot settle: the workflow, the autonomy, whether the run gets its own worktree, and in a folder of repositories which one. Each point has options, with the recommended one first. After your answer the agent starts the run and tells you the run id. The run appears in the runs panel and as a tab on **Work**. The pane stays open for your next question.

Text you paste from an issue, a pull request or a chat is data for the task. The agent does not follow instructions found in it.

### The form

**Advanced…**, next to **+ New session**, opens a form instead of a conversation. You fill in what the agent would have asked.

| Field | What you choose |
|---|---|
| **Repository** | which repository the run belongs to; shown only when the daemon serves a folder of repositories |
| **Workflow** | one of the repository's workflows, `mt-feature` to begin with ([the table below](#pick-a-workflow)) |
| **Task** | what to do, in one or two sentences |
| **AI host** | the AI host whose agents work on the run: the first installed one of `supervisor.hostOrder` is chosen, a host that is not installed is greyed out; or **create only, start the agent later** |
| **Autonomy** | the levels the chosen workflow runs at, for example **L0: every approval waits for you** and **L1: skips the approvals the workflow lets it skip** ([Gates and approvals](../guide/gates.md#autonomy)) |
| **Worktree** | a worktree with its own ports (ticked by default), or the main checkout ([Sessions and worktrees](./sessions.md#what-a-worktree-gives-a-run)) |
| **Parent run** | an active run this one is a step of, or **none (standalone)** |

The bottom line of the form shows the `metator run init` command your choices amount to. **Create in background** starts the run and leaves you where you are. **Create and attach** starts it, opens its **Session** screen and gives you its keyboard; the app asks for your name first if it does not know it yet. `Esc` closes the form.

When as many runs already wait for you as `supervisor.wipLimit` allows (default 4), the form warns that the new one queues behind them.

### From the backlog

On the **Backlog** screen, **Start a run** on an open task starts a run with the task's title and text, on the workflow chosen beside the button ([Plan and backlog](./plan.md#backlog)).

## In Copilot Chat or Claude Code

Address the same agent in your AI tool's chat:

```text
@mt-orchestrator cap the discount at 100 and test it
```

It asks the same numbered questions and starts the run. You can also name the workflow yourself:

```text
@mt-orchestrator run mt-bugfix for: Invoices with a 100% discount show a negative total.
```

A run started this way shows up in the app like any other, as long as the daemon runs in that repository.

## From a terminal

```bash
metator run
```

This asks for the workflow (starting at `mt-feature`), the task, the autonomy level (only the levels the workflow runs at), the AI host (only the ones installed) and whether the run works in its own git worktree. A question with one possible answer is not asked; the answer is shown instead. Then it drives the run in the background and shows it live. Ctrl+C leaves the view. The run goes on and waits for you.

```bash
metator run continue          # pick a run that waits for you or stopped, and watch it again
metator run continue <run>    # that run
```

In a script or in CI, use the commands the prompt is made of:

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run drive --host claude --detach
```

`run init` creates the run at its first stage. `run drive` carries it stage by stage. Without `--host` it uses the first of `hosts.targets`. The [command reference](../reference/commands.md#metator-run-init) lists every option.

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
