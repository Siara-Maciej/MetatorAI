# Desktop app and terminals

The desktop app is a window over the local daemon, `metator serve`. It shows every session in a real terminal, the inbox beside them, and the plan, the backlog and the change of each run. This page covers starting it, its screens, and how you and the agents share a terminal.

## Start it

Start the daemon in your repository, or in a folder of repositories:

```bash
metator serve
```

It listens on `http://127.0.0.1:4310`. Then open the app. The installers are built by the `desktop` workflow on GitHub: `metatorai-desktop-windows-x64`, `metatorai-desktop-macos-universal` and `metatorai-desktop-linux-x64`. From a clone of MetatorAI you can run the window directly:

```bash
cd packages/desktop && bun run tauri dev     # needs Rust and the platform's webview
```

The app looks for the daemon at the default address. To point it elsewhere, use the **Settings** screen or add `?daemon=http://127.0.0.1:4310` to the address. Type your name once. It signs every answer and every attach.

## Screens

| Screen | What you do there |
|---|---|
| **Inbox** | answer the gates, permissions and questions of every run ([Answer questions](./inbox.md)) |
| **Work** | the workbench: a tab per task or shell, with its panes |
| **Backlog** | add tasks, decide agents' proposals, start a run on a task ([Plan and backlog](./plan.md#backlog)) |
| **MRs** | reviews of your pull requests and the replies to send ([Answer a review](./reviews.md)) |
| **Graph** | runs by repository, with parent and child links and shared files |
| **Super** | the daemon, the hosts and the supervisor's settings and figures |
| **Settings** | every option, with its value and where it comes from |

A run adds three more: **Session** (its stages, panes, open question, applications and changes), **Plan** ([Plan and backlog](./plan.md)) and **Changes** ([Read the change](./changes.md)). When you return to a session after ten minutes away, a briefing opens first. It lists what happened since you left: transitions, decisions, files and errors.

The sessions panel on the left lists the runs, the ones that wait for you first. **+ New session** opens a conversation with the agent ([Start a task](./index.md)).

## The workbench

Each run in its worktree is a tab. Under the tabs are the run's stages. The tab's area is split into panes: the agents' terminals and your own shells. Drag a divider to resize.

A right click on a pane or a tab opens its menu. Every action also has a key: press the prefix, `ctrl+b`, then one key.

| Key after the prefix | Does |
|---|---|
| `c` | a new shell pane |
| `t` | a new tab for a task |
| `v`, `-` | split the pane to the right, downward |
| `h` `j` `k` `l` or the arrows | move the focus |
| `z` | zoom the pane, and back |
| `g` | go to an agent, tab or question |
| `n` | the next session that waits for you |
| `a`, `escape` | take the keyboard of the pane's session, give it back |
| `[` | copy mode: select and search in the scrollback |
| `x` | close the pane |
| `p`, `r`, `b` | the run's plan, its changes, the backlog |
| `?` | the list of keys |

Each key is an option (`keys.*`) that you can change in **Settings**.

A shell pane takes your keys at once. In an agent's pane the app asks before it takes the keyboard. The option `ui.attachOnType` changes that to `always` or `never`.

## Who types in a session

A session has one driver at a time: the agent, or a person who attached. Attaching takes the keyboard and puts your name on the session.

```bash
metator attach 20261109-feature-x --by alice     # the run's main pane, in your terminal
metator attach w1:p2 --by alice                  # one pane; `metator pane list` names them
```

`Ctrl-]` detaches and gives the session back to the agent. `--keep` keeps it yours. While you hold a session, another person is refused. `metator run attach --by alice` and `metator run release` take and return the lock without opening the terminal.

While you are attached, your yes in the chat counts: the agent records it with your name. This never applies to a push or a pull request comment. Those are always approved outside the chat.

## Agents in panes

Under the daemon, a run's coordinator sits in a pane of its own, the conductor pane, and starts each worker agent in another pane. You see every agent work.

```bash
metator run start        # open the run with its conductor pane
metator run workers      # who works now, in which pane, with which result so far
metator pane list        # every pane with its state
```

The workflow still sets the stages, their agents, the gates and the limits. A worker gets its whole task once, as a card, and reports with a result file. Agents do not type into each other's panes. A worker that is blocked becomes a question in your inbox under the worker's name.

The daemon reads each pane's state from the screen and the hooks, without asking the agent:

| State | Meaning |
|---|---|
| `working` | output or a hook call in the last moments |
| `blocked` | the host's own permission prompt is on the screen; only a person answers it |
| `waiting` | a question of the run waits in the inbox |
| `idle` | the host's prompt line, or silence |
| `exited` | the process ended |

If a conductor's session ends while its run is active, the supervisor in the daemon resumes it in the same pane, a limited number of times. A session a person holds is left alone.

## Your own shells and splits

```bash
metator pane split w1:p2 --dir down                 # a shell below the pane
metator pane split w1:p2 --dir right --argv top     # a command beside it
```

The shell is `terminal.shell`, or `$SHELL` when that is not set. A tab remembers its layout, so the panes come back the same way after the daemon restarts.

## Notifications

A new question or an escalation raises a system notification with the question's text. On the workbench it also shows as a toast. A click opens the tab. `notify.channel` chooses where questions are announced, or turns them off ([Configuration](../reference/configuration.md#notifications)).
