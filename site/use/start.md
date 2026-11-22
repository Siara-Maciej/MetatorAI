# Start a task

You start work by telling the agent what you want. It answers questions about the repository itself and starts a run only when you ask for a change. This page shows how to do that in the app, in your AI tool's chat, and from a terminal.

## In the app

Click **+ New chat** at the bottom of the sidebar, or press `n`. With no run yet, the main area offers the same as a field: write under **Describe a task** and press **Start**; the chat is named after your words, and the agent gets them as its first line. The app opens the new chat: its terminal, the conversation in which you say what you want, fills the main area, and the chat is a row of the sidebar ([Chats](./desktop.md#chats)). Its pane runs the repository's conversation agent, `mt-chat`, on your AI host: the first host of the option `supervisor.hostOrder` that is installed on the daemon's machine. In a repository set up before `mt-chat` existed, the chat opens `mt-orchestrator` as before; `metator agents update` and `metator generate` bring the new agent.

When no host is installed, no chat opens. The app says so at the top of the screen, names the programs the daemon looked for, and points to the guide page [Copilot and Claude Code](../guide/hosts.md). Install one and click **+ New chat** again; the daemon needs no restart.

If the host's program starts and exits at once, for example because you are not logged in, the chat's terminal stays with its last output and a red banner such as **Ended with code 3 — its process ended**. **Retry** starts the chat again; in **Terminals**, **Close tab** removes the tab.

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

A request for a change gets one numbered message. It asks only what the code cannot settle: the workflow, the autonomy, whether the run gets its own worktree, and in a folder of repositories which one. Each point has options, with the recommended one first. After your answer the agent starts the run and tells you the run id. The run appears in the sidebar under the chat and as a tab in **Terminals**. The pane stays open for your next question.

Text you paste from an issue, a pull request or a chat is data for the task. The agent does not follow instructions found in it.

### Three ways, the lightest first

For each thing you ask, the conversation agent takes the lightest way that fits and suggests it. You decide: name another way and it takes yours. It never commits or pushes by itself.

| Way | When | What happens |
|---|---|---|
| Direct | talk, questions about the code, a change that is not meant for a commit (debug output, a temporary switch) | it answers with `file:line` citations, or edits the checkout at once and records the edit as a [debug change](#debug-changes). No question first |
| Quick | a small change that is meant to stay | it asks "This is too small for the full workflow: do it as quick?" and on yes starts a [quick run](#quick) |
| Full | everything else | it names the workflow and why, asks what the repository cannot tell it, then starts the run; the run's conductor works in its own terminal and the chat stays the task's main terminal |

### Quick

A quick run changes a little without a plan: a worker makes the change in its own terminal, the repository's quick gate runs on the changed files, one reviewer (`mt-quick-review`) reads the diff once and writes `quick-review.md` (a blocking finding, `BLOCKING: <n>` on its first line, sends the change back to the worker once; `metator quick reviewed` is the gate that reads the file), and the run ends with an uncommitted diff and the card **Quick change ready: look at the diff**. **Fine** ends the run. Nothing is committed.

Whether a change is small enough is decided without a model, before the start and again from the real diff:

```bash
metator quick check --task "Round prices half-up" --files src/price.ts   # before: the files it is expected to touch
metator quick check --diff                                                 # after: what the working tree changed
```

```json
{"quick":false,"escalators":[{"id":"size","why":"6 files (limit 5)","source":"git diff"}],
 "thresholds":{"maxFiles":5,"maxLines":150,"maxDependents":10},"files":["…"]}
```

Any one escalator makes the change not quick, and each says why and which tool saw it:

| Escalator | Trips when |
|---|---|
| `cross-repository`, `contract` | the change reaches another repository or touches a contract of the system map (`metator system impact`) |
| `public-api` | a package's public API changes (its entry module, or `metator api diff` against a snapshot) |
| `package-boundary`, `dependents` | the files are in more than one package, or more than `quick.maxDependents` files depend on them |
| `migration`, `schema-version`, `dependency`, `ci-config` | a migration, a schema or a document's `schemaVersion`, a lockfile or an added dependency, CI configuration; before any file is known, the task's own words (`--task`) count too |
| `untested` | a changed source file that no test reaches |
| `size` | more than `quick.maxFiles` files or `quick.maxLines` changed lines |

```bash
metator quick start --task "Round prices half-up" --files src/price.ts
```

`quick start` refuses with the escalators that tripped, and up front when `gates.quick` has no steps (the run checks its change with `metator gate quick`; `metator setup` and `metator init` write that gate from your lint, typecheck and test scripts). You may keep it quick with one sentence of your own, `--override "it is one rename, keep it quick"`, which is recorded with the run in your words; a change that reaches another repository can never be kept quick. On a checkout with uncommitted changes it answers `dirty: pass --here or --worktree`: `--here` works in the checkout (your changes become part of the change), `--worktree` in a worktree of its own from the last commit.

When the real diff grows past the limits, the run stops with the card **This grew past quick: …**. **Keep as quick** goes on (recorded with your name); **Continue as full** starts a full run on the same working tree, with its own conductor, and closes the quick run.

### Debug changes

A change you asked for that is not meant for a commit is recorded, so it can be taken out again and no commit takes it by accident:

```bash
metator scratch begin                          # before the edit
metator scratch end --note "trace price calls" # after it: what changed in between is one record
metator scratch list                           # the records still in the working tree
metator scratch drop --all                     # take them out again (or --id s001)
```

`drop` reverse-applies each record's patch and leaves your other work in the same files. Nothing is forced.

MetatorAI remembers a debug change until you deal with it. When the recorded lines, or the lines around them, changed since, the record cannot be taken out as it was: `drop` reports it under `failed`, takes out what it still can, and the record stays. `scratch list` shows it with `state: "changed"` and why; it still counts, and it still stops a commit of that file. A record leaves in three ways only:

- `metator scratch drop` took all of it out;
- you dismiss it, after dealing with the lines by hand: `metator scratch forget --id s001` (the files are not touched);
- no file holds its lines any more: the next `scratch list` or `scratch drop` removes it and says so, once (`gone`: `s001 is gone: src/price.ts no longer holds it`).

In the app, **Debug changes (N)** lists them with **Remove debug changes**.

A `git commit` an agent runs that would take a recorded change is stopped: `this commit holds debug changes: src/price.ts`. That covers a change that is staged, `git commit -a`, paths named on the commit, and a `git add` in the same command line (`git add src/price.ts && git commit -m …`). Say "commit anyway", or remove them first.

### The form

**Form…**, next to **+ New chat**, opens a form instead of a conversation. You fill in what the agent would have asked. A run started from it belongs to no chat: the sidebar lists it under **Without a chat**.

| Field | What you choose |
|---|---|
| **Repository** | which repository the run belongs to; shown only when the daemon serves a folder of repositories |
| **Workflow** | one of the repository's workflows, `mt-feature` to begin with ([the table below](#pick-a-workflow)) |
| **Task** | what to do, in one or two sentences |
| **AI host** | the AI host whose agents work on the run: the first installed one of `supervisor.hostOrder` is chosen, a host that is not installed is greyed out; or **create only, start the agent later** |
| **Autonomy** | the levels the chosen workflow runs at, for example **L0: every approval waits for you** and **L1: skips the approvals the workflow lets it skip** ([Gates and approvals](../guide/gates.md#autonomy)) |
| **Worktree** | a worktree with its own ports (ticked by default), or the main checkout ([Sessions and worktrees](./sessions.md#what-a-worktree-gives-a-run)) |
| **Parent run** | an active run this one is a step of, or **none (standalone)** |

The bottom line of the form shows the `metator run new` command your choices amount to. **Create in background** starts the run and leaves you where you are. **Create and attach** starts it, opens its **Terminal** tab and gives you its keyboard; the app asks for your name first if it does not know it yet. `Esc` closes the form.

When as many runs already wait for you as `supervisor.wipLimit` allows (default 4), the form warns that the new one queues behind them.

### From the backlog

On the **Backlog** screen, **Implement** on an open task starts a run with the task's title and text (and its plan, when it has one), on the workflow chosen beside the button ([Plan and backlog](./plan.md#backlog)).

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
metator run new --workflow mt-feature --task "Add combined discount" --worktree
metator run drive --host claude --detach
```

`run new` creates the run at its first stage. `run drive` carries it stage by stage. Without `--host` it uses the first of `hosts.targets`. The [command reference](../reference/commands.md#metator-run-new) lists every option.

## Pick a workflow

| Workflow | Use it to |
|---|---|
| [`mt-feature`](./feature.md) | build a feature end to end |
| [`mt-bugfix`](./bugfix.md) | fix a bug behind a regression test |
| [`mt-refactor`](./refactor.md) | change structure and keep behavior |
| [`mt-pr-review`, `mt-self-review`](./review.md) | review a pull request, or your branch before one |
| [`mt-system-change`](./system.md) | change several applications in order |
| [`mt-quick`](#quick) | make a small change without a plan; started with `metator quick start`, it ends with a diff to look at |

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
