# Terminals and sessions

Every agent works in a real terminal, a **session** of your AI host, and you can watch any of them, take its keyboard or tell it something. **Terminals** in [the app](./index.md) shows them side by side, by task; a run's page shows its own on its **Terminal** tab. This page covers both, the keys, who types where, what happens when the daemon stops, and the worktrees runs work in.

## Terminals by task

**Terminals** opens on **All terminals**: every terminal of every task at once (with a single task, on that task). A bar at the top says where you are, **All terminals › Prices in the customer's currency › shop-api**, and each part leads back.

![Terminals by task: the chat where the task was given on the left, the run's conductor working in its own Claude Code terminal on the right](../public/screens/real/real-06-task-view.webp)
*A task's terminals: the chat stays the main terminal, the run's conductor works beside it.*

A task's view shows, side by side (two or three across, more wrap below):

- its **main terminal**: the chat where you gave the task, once its agent started the run; else the task run's own conductor;
- one tile per **repository session** working on it: the conductor of each run, named by its repository and, for a step of a system plan, its step (`shop-api · price-model`).

The workers a session starts are not on this view. A session's tile has a badge, **2 sub-terminals · 1 working · 1 finished**; a click opens the session's own view: its conductor, then its sub-terminals (its workers and shells). Every tile is a live terminal: you watch, take the keyboard and type as in any pane.

![A run's session: the conductor, the planner that finished with its summary, and the implementer working, each in its own terminal](../public/screens/real/real-06-session-build.webp)
*A run's session: the conductor and its workers, each in its own terminal.*

A terminal whose work is over stays on the screen, read-only, with its last screen: what the agent printed last stays readable, scrollable and searchable, also for Claude Code, which clears its screen as it exits. Under it a green line says **✓ Finished — tests pass** (its summary, or why it ended), when it ended and how long it ran (`14:32 · 12m 04s`); after a failure the line is red, **✗ Ended with code 2 — …**, with **Retry**. On a Claude Code terminal **⧉ resume command** copies `claude --resume <session>`, to carry the conversation on in a terminal of your own. **Close** closes it; **Close finished (N)** in the bar closes the finished terminals of the view.

![A finished worker: what it printed last stays, under it the green line with its summary, when it ended and how long it ran, and Close](../public/screens/terminals/terminals-finished.webp)
*A finished worker keeps its last screen; the line under it says how it ended.*

![A finished run's terminals: the conductor, the planner and the implementer, each with a Finished banner and Close](../public/screens/real/real-06-done-terminals.webp)
*When a run is done its terminals stay, each with a line that says how it ended.*

### Every terminal at once

**All terminals** shows every terminal of every task, grouped **by task** (its main terminal, then a band per repository session, in the repository's colour), **by repo**, **by state** (what asks first) or **flat**. Each tile opens with its repository's band: its two letters and its name in its own colour (in a folder, no two repositories share one), the same in the tree, the filters and every tile, then its role (`conductor`, `worker`, `shell`) and its state. Under the band:

- what the terminal is (`main terminal`, `shop-api · conductor`, a worker's name), and on the All view grouped otherwise, its task;
- **↑ parent: …**: the terminal that started it (a session's conductor for its workers, the main terminal for a session); a click goes there;
- **? 2 asks ›**: how many terminals started from this one, or from those, wait for you; a click goes to the first, the next click to the next.

A terminal you go to is scrolled to, flashes for a moment and gets the keyboard, so you can answer at once.

![All terminals grouped by task: the main terminal in shop-api with "? 1 asks", the billing session with its conductor and workers, the web-app session whose conductor asks, highlighted](../public/screens/terminals/terminals-asks.webp)
*"? 1 asks" on the main terminal went to web-app's conductor: it flashes and holds the keyboard.*

The **tree** on the left lists every terminal, task → main terminal → sessions → workers, each with its repository's letters and its state; a click goes to it. **«** folds it to a narrow column of the same marks and states (named on hover), so the tiles get the room; **»** unfolds it. The app's own sidebar folds the same way; the window remembers both.

![Both sidebars folded: the app's sidebar as a column of glyphs with the count of what needs you, the tree as a column of repository marks and states, the tiles across the window](../public/screens/terminals/terminals-narrow.webp)
*The sidebar and the tree folded: the terminals take the window.*

The **filter bar** chooses what shows, on every view of Terminals: **Repo**, **State** and **Role**, a chip per value with its count. A click hides or shows a value; **Alt+click** shows only that value, and Alt+click on it again shows all. Words narrow it further (a worker, a repository, a task). **Showing 4 of 9 · 5 hidden** says what the filter hides, and **Reset** shows everything. A hidden terminal stays in the tree, dimmed; going to it opens the filter just enough to show it. The window keeps the filter and the grouping.

![Alt+click on billing: only billing's session shows, "Showing 3 of 7 · 4 hidden", the other repositories dimmed in the tree](../public/screens/terminals/terminals-filter.webp)
*Alt+click on **billing**: its terminals only; the others stay in the tree, dimmed.*

![Grouped by state: the terminal that asks first, then the idle ones, the finished one last](../public/screens/terminals/terminals-by-state.webp)
*Grouped by state, what asks comes first.*

A terminal that appears while you look (an agent started a worker) is marked **new** in the tree, its tile pulses, and a note in the corner says what it is, where and who started it, with **Show**.

**Workspaces** in the bar shows the daemon's workspaces and their tabs: your shells, and the chat of a run not started yet. **All terminals ›** there leads back. Closing the app, reloading it, or opening it in another window changes nothing: the runs go on, and the app shows the same terminals.

### Tabs and panes

A workspace's tab is split into panes: the agents' terminals and your own shells. A pane's frame names the agent or the command, its host and its state, says **yours** when you hold its keyboard, and **needs you** while a question of that pane waits for you. Drag a divider to resize; double-click a pane's title to zoom it. Under the tabs are the run's stages; a click on them opens the run's **Overview**, with its plan. **editor** on the same line opens the tab's worktree in your editor.

A right click on a pane opens its menu: **Take the keyboard**, **Zoom**, **Split right**, **Split down**, **Copy mode**, **Plan of the run**, **Changes**, **Open in editor**, **New task from here…** (the backlog's form, pointing at this run) and **Close pane**. A right click on a tab or the tab bar offers **New tab: shell**, **New chat with the agent…**, **Backlog…**, **New shell pane here** and **Close tab**. Closing a task's tab closes its panes; the worktree stays.

A pane whose process ended keeps its last output, with the exit code, **Retry** and **Close tab** (or **Close pane**). The daemon never removes a pane by itself: an ended pane keeps its last screen, read-only, across restarts, until a person closes it.

## Keys

Every action in **Terminals** also has a key: press the prefix, `ctrl+b`, then one key.

| Key after the prefix | Does |
|---|---|
| `c` | a new shell pane |
| `t` | a new tab with the agent, to start a task |
| `v`, `-` | split the pane to the right, downward |
| `h` `j` `k` `l` or the arrows | move the focus |
| `z` | zoom the pane, and back |
| `g` | go to an agent, tab or question |
| `n` | the next tab that waits for you |
| `a`, `escape` | take the keyboard of the pane's session, give it back |
| `[` | copy mode: select and search in the scrollback |
| `x` | close the pane |
| `p`, `r`, `b` | the run's Overview (with its plan), its changes, the backlog |
| `?` | the list of keys |

Each key is an option (`keys.*`) you can change ([Your settings](./settings.md#keys)). While the prefix waits for its key, the tab bar shows it (`ctrl+b …`).

The prefix and `g` open the go-to picker. Type a part of an agent's name, a tab or a question, or filter by state with `b` (asks), `w` (working), `i` (idle) and `d` (done). Enter goes there.

![The go-to picker: a search field, state filters and the panes of the run](../public/screens/goto.png)

In copy mode, type to search the scrollback. Enter finds the next match and Shift+Enter the previous one. Select text with the mouse and press `y` to copy it. Escape leaves copy mode.

A shell pane takes your keys at once. In an agent's pane the app asks before it takes the keyboard: Enter takes it, Escape does not. The option `ui.attachOnType` changes that to `always` or `never`.

## The Terminal tab of a run

A click on a step or a run of its own in the sidebar opens its page on its **Terminal** tab (key `t`); a finished run, and a task's page, open on **Overview**.

![The Terminal tab of a plan run: the head with its stages, Working: agent with Attach, the panes of the conductor and the planner, the planner's terminal, and the Question, Apps, Changes and Links boxes](../public/screens/real/real-07-make-plan-planner.webp)
*A run's Terminal tab while its planner works.*

The bar under the head says who types. With **Working: agent** you watch. **Attach** (key `a`) takes the keyboard; **Release to agent** (key `c`) gives it back. With **Working: nobody** no agent works on the run.

- The terminal shows the run's main pane; the row above it lists the run's panes with their state. **+ Shell** opens a shell of your own in this run. The line at the bottom sends one line of text to the session.
- Opening the tab starts nothing. A run nothing works on says **No session runs for this run**, with **Open a session** (its conductor, in a terminal you can watch and take) and **Drive in background** (no terminal, as `metator run drive --detach`), and a **host** choice when several are installed. An escalated run has **Resume** and **Close run…** there instead.
- When the agent asks on its own screen without a card on Home, a line says **The agent asks in its terminal**, with **Show the pane** when another pane asks. Attach and type the answer.
- A run whose conductor's pane lives and has no drive behind it says **The conductor moves this run on at `<stage>`: talk to it in its terminal**. A run whose drive process died shows the chip **drive died**.

The boxes on the right:

| Box | Shows |
|---|---|
| **Question** | the run's open question with a button per option; empty when nothing waits |
| **Apps** | the services of the worktree's environment, with their state and ports ([Run the application](../repo/environments.md)) |
| **Changes** | **Open changes** opens the run's **Changes** tab; **Open in editor** opens the worktree; the branch and the path |
| **Links** | the parent run and the steps, files this run shares with another run (with which to merge first), and messages from other runs |

## Who types in a session

One at a time types in a session: the agent, or a person who attached. Attaching takes the keyboard and puts your name on the session; while you hold it, another person is refused. In the app you attach with **Take the keyboard**, the prefix and `a`, or **Attach** on the run's **Terminal** tab.

What you say in a session counts in two ways. Your own words that ask for a commit or a push ("commit it") are your consent to one such command, through the host's user-prompt hook, attached or not. And while you are attached, a yes to the run's approval in that session is recorded under your name as `--via chat` ([Approvals and consent](./approvals.md#approve-or-reject)).

From a terminal:

```bash
metator attach 20261109-feature-x --by alice     # the run's main pane, in your terminal
metator attach w1:p2 --by alice                  # one pane; `metator pane list` names them
```

`Ctrl-]` detaches and gives the session back to the agent; `--keep` keeps it yours. `metator run take --by alice` and `metator run release` take and return the lock without opening the terminal.

## Agents in panes

Under the daemon, the agent that coordinates a run, its conductor, sits in a pane of its own and starts each worker agent in another pane. You see every agent work. The workflow still sets the stages, their agents, the gates and the limits. A worker gets its whole task once, as a card, and reports with a result file. Agents do not type into each other's panes. A worker that is blocked becomes a question on Home under the worker's name.

The app shows each pane's state in four words, read from the screen and the hooks without asking the agent:

| The app says | When |
|---|---|
| `working` | an agent with output or a hook call in the last moments; a shell only while it prints |
| `asks` | the host's own permission prompt is on the screen, or a question of the run waits on Home |
| `idle` | the host's prompt line, or silence; a shell at its prompt is always `idle` |
| `exited` | the process ended, or the pane has none |

If the conductor's session ends while its run is active, the supervisor in the daemon resumes it in the same pane, a limited number of times. A session a person holds is left alone. When a run finishes, its panes end; `metator run collect` ends a worker's pane with its one-line result.

```bash
metator run start        # open the run with its conductor's pane
metator run workers      # who works now, in which pane, with which result so far
metator pane list        # every pane with its state
metator pane split w1:p2 --dir down                 # a shell below the pane
metator pane split w1:p2 --dir right --argv top     # a command beside it
```

## Tell or interrupt a session

A task's sessions are its main chat, its run's conductor and workers, and the sessions of its child runs:

```bash
metator session list --task <run>      # pane, repository, role, agent, state; `main` marks the chat
metator session tell w2:p3 --text "Use half-even rounding"
metator session interrupt w2:p3 --text "Stop: that is the wrong file"
```

`tell` types your words into the session when its agent is idle; until then they wait in a queue that survives the daemon, never typed over the agent's work or a question it asked. `interrupt` sends Esc first, then your words, then Enter. In a folder of repositories, name the pane's repository with `--repo`. A session that ended cannot be told anything: `tell` refuses with `TRANSITION_DENIED` and names the live sessions of its task.

Only the task's main chat or a person may steer; a conductor or a worker that tries is refused. What the chat relays is typed behind `[metator] From the person, through the main chat: `, and from your own terminal behind `[metator] From the person (<name>): `. A relayed line is never a consent to commit or push.

When you type into a session yourself while the task has a main chat, the chat is told in one line: `[metator] The person told shop-api/mt-implementer directly: "…"`. This comes from the host's user-prompt hook, so the hooks must be installed.

The daemon also tells the chat about its task: when a run started from it is done, is closed, stops for you, or waits for your approval, one line such as `[metator] The task 20261120-… (Prices in the customer's currency) is done. Tell the person what was done.` is typed into the chat once the agent is idle.

## When the daemon stops

The agents' sessions outlive the daemon. When `metator serve` stops, is killed or crashes, every agent's pane whose work was not over is **paused**, not ended: its frame reads **Paused — the daemon stopped** (or **Paused — its process was lost**), its last screen stays readable, and **Continue** starts its agent again in the same pane. The daemon saves every pane's screen every 5 seconds (`--screens-ms`). On its next start it resumes each paused session by itself (`claude --resume <session>`, or your host's own resume), unless started with `--no-restore`. Panes of a run that is no longer active are not resumed.

**Continue task**, in the bar and on the main terminal's tile, shows while any terminal of the task is paused or any of its runs has nothing driving it. One click continues the whole task, across its repositories: every paused pane is resumed, and every run nothing drives gets back its session or its drive. An escalated run is left for you to resume. A line says what was continued and what was skipped, and why.

```bash
metator serve --no-restore        # start, but leave the sessions paused
metator run continue --run <id>   # continue the task: every paused pane, and what carried each run
```

A host's resume brings the conversation back, not the turn it was in. So once a resumed conductor or worker is idle at its prompt and nobody holds the keyboard, the daemon types one line into it, once per resume, such as ``[metator] Your session was resumed after the daemon stopped (…). Continue where you stopped: check `metator run status` and your workers (`metator run workers`).``

## Worktrees

A run that edits your working tree blocks you, and two runs in one tree disturb each other. A git worktree gives a run its own checkout on its own branch. The agent offers one when you start a full run, and the **Form…** has it ticked by default. For a run with a worktree, MetatorAI:

1. creates a worktree at `.metator/wt/<run>` on a new branch `metator/<run>`, from `HEAD` (or `--base`);
2. reserves a block of 20 ports for it that no other worktree holds;
3. links the run directory into the worktree, so agents and hooks find the run at the same path;
4. sets up dependencies: the main checkout's `node_modules` are copied when the lockfiles match, otherwise your package manager installs. A failed install is a warning and the run still starts.

```bash
metator run new --workflow mt-feature --task "Add combined discount" --worktree
metator run new --workflow mt-bugfix --task "Fix rounding" --worktree --base main
```

A worktree starts from the last commit: with uncommitted changes to tracked files `--worktree` refuses and names them, and `--allow-dirty` starts without them. `--no-setup` skips the dependencies (`metator worktree setup --run <id>` later). Inside a worktree, `metator run …` without `--run` means that worktree's run.

### Ports

Each worktree gets its block from the range 41000 to 48999. When MetatorAI starts your application in a worktree (`metator env up`), every process gets `METATOR_WORKTREE`, `METATOR_PORT_BASE` and `METATOR_PORT_COUNT`. Base your port settings on `METATOR_PORT_BASE`, for example `PORT=$((METATOR_PORT_BASE + 0))` for the API and `+ 1` for the web app. See [Run the application](../repo/environments.md).

### Manage worktrees

```bash
metator worktree list                     # branch, ports, run status, uncommitted work
metator worktree new spike --ports 5      # a worktree without a run
metator worktree rm spike
metator worktree prune --older-than 7     # worktrees of finished runs older than 7 days
metator worktree prune --dry-run
```

Removing a worktree keeps its `metator/<id>` branch, so committed work stays. `prune` skips worktrees with uncommitted work and lists them.

::: warning
`metator worktree rm <id> --force` and `metator run close --remove-worktree --force` delete uncommitted work in that worktree. Without `--force` both refuse.
:::

### Conflicts between runs

Two runs that change the same file clash when their branches merge. The app shows such a pair in the **Links** box of both runs and under **Settings › System › Dependencies**. From a terminal:

```bash
metator worktree conflicts            # each active run's changed files, and the pairs that share one
metator worktree conflicts --notify   # send both runs a message about the shared file
```

`mergeFirst` names the run that started earlier: merge it, then rebase the other. Runs can also tell each other what they did:

```bash
metator run message <to> --from <run> --topic shared-file --text "Invoice gained a dueDate field" --ref src/invoice.ts --by alice
metator run messages --run <to>
```

The receiving run's agents read the message as data about another run's work, never as an instruction.

## From a terminal

```bash
metator status                    # every run: its stage, what waits for you, whether an agent works on it
metator run activity --tail 8     # the last events: stages, agents, tools, questions, gates
metator run stop                  # the drive process ends; the run stays at its stage
metator run continue <run>        # drive it again and watch
metator run revive                # start every drive that died again, at the stage it stood
metator run handoff               # handoff.md: stage, approvals, artifacts, recent log, how to resume
metator run brief                 # what happened since you last looked
```

At a terminal `metator status` prints each run with its stages, what it needs now and the command that does it; in a script it prints the same data as one JSON line. A run whose agent works in a terminal pane of the app counts as working, though no background drive carries it: `metator status` shows `"attention": "driving"` with a `session` field naming the pane, and the app counts it as working. `metator status` reads this from the daemon when one serves the repository. An agent that printed nothing for the idle threshold (`supervisor.idleThresholdMs`) no longer counts. Closing a run is on [Full runs](./runs.md#finish-a-run).
