# Plan and backlog

The plan board shows where one run stands and what is left. The backlog is the repository's list of tasks that are not runs yet. This page covers both.

## See where a run stands

```bash
metator run board                 # the latest run
metator run board --run <id>      # one run
```

The board has:

| Part | Shows |
|---|---|
| `stages` | each stage with its state, who worked it, when, and its verdict |
| `plan` | the plan's steps, each with its file, its state and the evidence for that state |
| `waiting` | the open questions, oldest first |
| `artifacts` | the files the stages produce, and whether each is there |
| `gates` | the last results of the quick and the full gate |
| `next` | the stages still to come |

No model writes the board. It is computed from the run's files when you ask:

- A step is `done` when a worker reported done and named the step's file or id.
- A step is `in-progress` when the activity shows a tool call on its file.
- A step is `blocked` when a worker reported blocked or failed and named the step.

`--timeline <n>` sets how many recent events the board includes (default 30).

In the desktop app, the **Plan** screen shows the board. The steps are on the left and the chosen step on the right, with its file, tests, exemplar and rules. The question that waits for you is at the top with its answers. Open it from the workbench with the prefix and `p`, or by clicking the stages under the tabs.

## Backlog

The backlog is in `.metator/issues/`, one small file per task.

```bash
metator issue add "ADR for rounding" --body "Half-up or half-even." --priority high --labels adr,billing --by maciej
metator issue list                # proposals first, then in progress, then open by priority
metator issue show i001
metator issue close i001 --by maciej     # done
metator issue drop i002 --by maciej      # not going to be done
```

Commands that change a task take `--by <name>`. Agents never add, edit, close or drop a task.

## Start a run on a task

```bash
metator issue start i001 --workflow mt-feature
```

The run's task is the issue's title and body. It works in a new worktree unless you pass `--no-worktree`. The issue becomes `in-progress` and remembers the run. `metator issue list --run <id>` lists the tasks tied to a run: started from it, proposed in it, or pointing at it.

## Decide an agent's proposal

An agent that notices something outside its task, such as a flaky test or a missing edge case, can propose a task. The proposal becomes a question in your inbox with the agent's name and three answers: **Add to the backlog**, **Add and start a run**, or **Drop**.

You can decide from the terminal too:

```bash
metator issue decide i002 --add --by maciej
metator issue decide i002 --drop --by maciej
```

A proposal cannot be started before someone decides it. Every issue records who proposed it, what it points at, and who decided.

To switch proposals off, set the option `issues.proposeFromAgents` to `false`. Agents then mention such things in their summary instead.

## In the desktop app

The **Backlog** screen lists the proposals, then the open tasks, with the finished ones folded at the bottom. The chosen task shows its text, priority, labels, references and run, with the buttons that apply to it. **+ task** adds one.

Tasks can also arrive from GitHub, GitLab or Jira on their own: see [Automatic intake](./intake.md).
