# Plan and backlog

The **Plan** screen shows where one run stands and what is left. The **Backlog** screen is the repository's list of tasks that are not runs yet. This page covers both, in the app and from a terminal.

## See where a run stands

Open **Plan** from the **Work** screen: click the stages under the tabs, or press the prefix and `p`.

![The Plan screen of a run before its plan is written: the stage, what comes next, the artifacts and the last events](../public/screens/plan.png)

| Part | Shows |
|---|---|
| Stages, top right | each stage with its state; hover for who worked it, when, and its verdict |
| **steps**, left | the plan's steps with their state, file and worker, and a count of the ones done |
| **waits for you**, left | the open questions, oldest first |
| The chosen step, right | its file, the tests that come first, the exemplar, the rules, and the steps it comes after |
| **what comes next** | the stages still to come, and the last results of the quick and the full gate |
| **artifacts** | the files the stages produce, and whether each is there |
| **workers** | the run's worker agents, each with its stage, pane and result so far |
| Timeline, bottom | the last events of the run |

Click a step to see it. **Show the pane** opens the step's worker on the workbench, and **The session** opens the run's **Session** screen.

When a question waits, it is at the top with its answers as buttons, the recommended one highlighted. A click answers it. For a permission prompt of the host the button is **Answer in the pane**.

No model writes this screen. It is computed from the run's files when you look:

- A step is `done` when a worker reported done and named the step's file or id.
- A step is `in-progress` when the activity shows a tool call on its file.
- A step is `blocked` when a worker reported blocked or failed and named the step.

Before the plan stage has written `plan.json`, the list of steps is empty.

## Backlog

The backlog is in `.metator/issues/`, one small file per task. Agents never add, edit, close or drop a task. They can only propose one.

![The Backlog with an agent's proposal: the list on the left, the proposal with Add, Add and start a run, and Drop](../public/screens/backlog.png)

The **Backlog** screen lists **agents' proposals** first, then the **open** tasks, with the finished ones folded at the bottom. The chosen task shows its text, priority, labels, references and run, with the buttons that apply to it:

| Button | On | Does |
|---|---|---|
| **+ task** | the top bar | opens a form: title, what and why, priority, labels |
| **Start a run** | an open task | starts a run with the task's title and text, in a new worktree, and opens its session. The select **a run starts on** beside the buttons names the workflow: `mt-feature` when the repository has it, else its first one |
| **Done**, **Drop** | an open task | closes it as done, or as not going to be done |
| **Add** | a proposal | makes it a task |
| **Add and start a run** | a proposal | makes it a task and starts a run on it |
| **Drop** | a proposal | discards it |

The app asks for your name the first time. Every change to the backlog carries it. When the daemon refuses an action, the reason stays at the top of the task until you close it.

### Proposals from agents

An agent that notices something outside its task, such as a flaky test or a missing edge case, can propose a task. The proposal appears on the **Backlog** screen and as a question in your inbox, with the agent's name and three answers: **Add to the backlog**, **Add and start a run**, or **Drop**.

A proposal cannot be started before someone decides it. Every task records who proposed it, what it points at, and who decided.

To switch proposals off, set the option `issues.proposeFromAgents` to `false`. Agents then mention such things in their summary instead.

Tasks can also arrive from GitHub, GitLab or Jira on their own: see [Automatic intake](./intake.md).

## From a terminal

```bash
metator run board                 # the latest run
metator run board --run <id>      # one run
```

The board is the data of the **Plan** screen as JSON: `stages`, `plan`, `waiting`, `artifacts`, `gates` and `next`. `--timeline <n>` sets how many recent events it includes (default 30).

```bash
metator issue add "ADR for rounding" --body "Half-up or half-even." --priority high --labels adr,billing --by maciej
metator issue list                # proposals first, then in progress, then open by priority
metator issue show i001
metator issue start i001 --workflow mt-feature
metator issue close i001 --by maciej     # done
metator issue drop i002 --by maciej      # not going to be done
```

Commands that change a task take `--by <name>`. `issue start` makes the issue `in-progress` and remembers the run. A task whose run is still active is not started a second time: the command is refused and names the run. The run works in a new worktree unless you pass `--no-worktree`. When tracked files have uncommitted changes, the start is refused and names them: commit or stash them, or pass `--allow-dirty` to start from the last commit without them. In the app, the refusal comes with the button **Start from the last commit**, which does the same. `metator issue list --run <id>` lists the tasks tied to a run: started from it, proposed in it, or pointing at it.

```bash
metator issue decide i002 --add --by maciej
metator issue decide i002 --drop --by maciej
```
