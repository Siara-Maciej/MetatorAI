# The desktop app

MetatorAI Desktop is a window over `metator serve`: every decision comes to one inbox with its evidence, every session is visible in a real terminal, and sessions that depend on each other are shown together. The app draws; the daemon decides (ADR-0077, ADR-0078).

## Download it

The `desktop` workflow builds the installers on GitHub for every push that touches the app: open **Actions → desktop → the latest run → Artifacts** and take `metatorai-desktop-windows-x64` (an `.exe` installer and an `.msi`), `metatorai-desktop-macos-universal` (one `.dmg` for Apple Silicon and Intel), or `metatorai-desktop-linux-x64` (`.deb`, `.AppImage`). A tag `desktop-v<version>` publishes the same files on a GitHub Release (as a draft pre-release the owner makes public). The installers are not code-signed yet: Windows SmartScreen and macOS Gatekeeper ask once (macOS: right-click → Open, or `xattr -d com.apple.quarantine` on the app).

The app is a window over the daemon: run `metator serve` from the repository first (see below), then point the app at it.

## Start it

```bash
metator serve                         # the local daemon, http://127.0.0.1:4310
cd packages/desktop && bun run tauri dev   # the window (needs Rust and the platform's webview)
# or, in any browser:
cd packages/desktop && bun run build && bunx vite preview --open
```

The app finds the daemon at `http://127.0.0.1:4310`; `?daemon=http://127.0.0.1:4310` or the **Settings** screen (⚙ in the rail, section *app*) points it elsewhere. Your name, typed once, signs every answer and attach.

## Screens

| Screen | What it is for |
|---|---|
| **Inbox** (`#/inbox`) | The decision queue: gates, permissions and questions of every run, the most urgent first. The decision card shows the goal, what happened since you last answered, the evidence, each option's consequence and the recommended one. Answering here counts as "without opening the session" (criterion 11a). `g` next, `o` open the session. |
| **Session** (`#/session/<run>[/<pane>]`) | One run: the stage bar, the driver bar (attach to type, release to let the agent drive), its panes as tabs (the conductor, each worker, shells; each with its sensed state: working, blocked, waiting, idle, exited), the terminal of the chosen pane or the events table, the open question, the worktree's apps and changes, the links to its parent, steps, messages and shared files. `+ Shell` opens a shell pane in the run's worktree, `✕` closes a pane. `a` attach, `c` release, `t` toggle events. |
| **Work** (`#/grid`) | The workbench, shaped like herdr: a tab per task (a run in its worktree) or per shell, the run's stages under the tabs, the panes of the tab in their split tree (drag the dividers), a sidebar of repositories and their agents with each pane's state. Everything else is a right click (on a pane: take or give back the keyboard, zoom, split, copy mode, close; on a tab: a new shell or task tab, close) or a key after the prefix (`ctrl+b`, then `c` shell, `t` task, `v` / `-` split, `z` zoom, `g` go to, `n` next waiting, `a` / `esc` take / give back the keyboard, `[` copy mode with search, `x` close, `?` the list). A shell pane takes your keys at once; an agent's pane asks to take the keyboard first (`ui.attachOnType`). Every key is an option (`keys.*`) and changes without a restart. |
| **Plan** (`#/plan/<run>`) | The run's plan board: stages with who worked them, the plan's steps with their live state (done, in progress, blocked, to do) and the evidence for each, the question that waits for you with its answers, what comes next, the artifacts, the workers and their panes, the last events. See [The plan of a run](./plan.md). |
| **Backlog** (`#/backlog`) | The repository's tasks: agents' proposals that wait for your decision, the open tasks, the finished ones folded; add a task, start a run on one, mark it done or drop it. See [The backlog](./backlog.md). |
| **Changes** (`#/review/<run>`) | What the run changed, file by file with the diff; a note on any line, sent to the agent as one message; the editor at the line. See [The change and your notes on it](./changes.md). |
| **Graph** (`#/graph`) | Lanes per repository, parent → child arrows, dashed links for messages and shared files, with "Notify both" for a conflict. |
| **Supervisor** (`#/supervisor`) | The daemon, the hosts, the supervisor policy, the fleet, and the acceptance figures: median time from question to answer, share answered from the card (goal ≥ 80%), restarts and nudges in the last 24 hours. |
| **Briefing** (`#/briefing/<run>`) | "Since you left": transitions, decisions, files, errors, grouped by stage, deterministic from the run's events. Opens by itself when you come back to a session after ten minutes away. |
| **New session** (`n`) | The dialog: repository, workflow, task, host (the first of `supervisor.hostOrder`), autonomy, worktree, parent run, "attach me when it first asks"; the footer shows the `metator run init` it amounts to. |

A run with more than its conductor pane lists its panes under its row in the sessions panel, each with its state; clicking one opens the session on that pane. The sessions panel on the left has two modes: **App** (per repository) and **Run** (feature groups as frames with their steps, then standalone runs). Both sort: waits for you → working → stopped → escalated → finished.

## Notifications

A new question or an escalation raises a system notification (Tauri's plugin in the window, the browser's Notifications API otherwise) with the question's text. On the workbench the newest question of a tab shown there is also a toast; clicking it opens the tab and takes the keyboard of its conductor pane (`notify.channel` turns it off).

## What the daemon adds for the app

| Endpoint | Returns |
|---|---|
| `GET /workflows` | the workflows of the repository |
| `GET /supervisor` | the daemon, hosts, policy, live PTY sessions, acceptance figures |
| `GET /report` | the same report as `metator report` |
| `GET /runs/<id>/brief`, `POST /runs/<id>/seen` | `metator run brief` and marking it read |
| `POST /runs` | `{workflow, task, autonomy?, worktree?, parent?, drive?: host}`: `run init`, the worktree's setup, and the drive on that host |
| `WS /ws/inbox` | the inbox, pushed on change |
| `GET /runs/<id>/board` | the plan board of `metator run board` |
| `POST /runs/<id>/open-editor`, `POST /panes/<id>/open-editor` | `{file?, line?}`: the editor of `editor.command` on the run's worktree or the pane's directory |
| `GET /runs/<id>/review?file=`, `GET\|POST /runs/<id>/review-notes`, `POST /runs/<id>/review-send`, `POST /runs/<id>/review-note-status` | the change as files and hunks; the notes, a new note, the drafts sent as one message, a note's status |
| `GET /issues`, `POST /issues`, `POST /issues/<id>/decide\|edit\|close\|drop\|start` | the backlog of `metator issue`; a POST carries `by` where a person decides |
| `GET /options`, `POST /options/<key>` | every option with its value and source; a set (`{scope, value}`) or a reset (`{scope, reset: true}`) |
| `POST /panes/<id>/split` | `{dir: right\|down, argv?}`: a shell (your `terminal.shell`, else `$SHELL`) beside or below the pane, in the tab's split tree |
| `POST /tabs/<id>/tree` | the tab's split tree as the app arranged it (a divider drag); its leaves must be the tab's panes |

An answer sent with `origin: "inbox"` is written to the run's activity as such; the Supervisor's 11a tile counts those.
