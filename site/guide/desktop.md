# The desktop app

MetatorAI Desktop is a window over `metator serve`: every decision comes to one inbox with its evidence, every session is visible in a real terminal, and sessions that depend on each other are shown together. The app draws; the daemon decides (ADR-0077, ADR-0078).

## Start it

```bash
metator serve                         # the local daemon, http://127.0.0.1:4310
cd packages/desktop && bun run tauri dev   # the window (needs Rust and the platform's webview)
# or, in any browser:
cd packages/desktop && bun run build && bunx vite preview --open
```

The app finds the daemon at `http://127.0.0.1:4310`; `?daemon=http://127.0.0.1:4310` or the ⚙ field in the top bar points it elsewhere. Your name, typed once, signs every answer and attach.

## Screens

| Screen | What it is for |
|---|---|
| **Inbox** (`#/inbox`) | The decision queue: gates, permissions and questions of every run, the most urgent first. The decision card shows the goal, what happened since you last answered, the evidence, each option's consequence and the recommended one. Answering here counts as "without opening the session" (criterion 11a). `g` next, `o` open the session. |
| **Session** (`#/session/<run>[/<pane>]`) | One run: the stage bar, the driver bar (attach to type, release to let the agent drive), its panes as tabs (the conductor, each worker, shells; each with its sensed state: working, blocked, waiting, idle, exited), the terminal of the chosen pane or the events table, the open question, the worktree's apps and changes, the links to its parent, steps, messages and shared files. `+ Shell` opens a shell pane in the run's worktree, `✕` closes a pane. `a` attach, `c` release, `t` toggle events. |
| **Grid** (`#/grid`) | A feature group as a 1 / 2×2 / 3×3 grid of terminals; pin any other session; one tile at a time is yours to type in. "Follow" focuses the next session that needs you. |
| **Graph** (`#/graph`) | Lanes per repository, parent → child arrows, dashed links for messages and shared files, with "Notify both" for a conflict. |
| **Supervisor** (`#/supervisor`) | The daemon, the hosts, the supervisor policy, the fleet, and the acceptance figures: median time from question to answer, share answered from the card (goal ≥ 80%), restarts and nudges in the last 24 hours. |
| **Briefing** (`#/briefing/<run>`) | "Since you left": transitions, decisions, files, errors, grouped by stage, deterministic from the run's events. Opens by itself when you come back to a session after ten minutes away. |
| **New session** (`n`) | The dialog: repository, workflow, task, host (the first of `supervisor.hostOrder`), autonomy, worktree, parent run, "attach me when it first asks"; the footer shows the `metator run init` it amounts to. |

A run with more than its conductor pane lists its panes under its row in the sessions panel, each with its state; clicking one opens the session on that pane. The sessions panel on the left has two modes: **App** (per repository) and **Run** (feature groups as frames with their steps, then standalone runs). Both sort: waits for you → working → stopped → escalated → finished.

## Notifications

A new question or an escalation raises a system notification (Tauri's plugin in the window, the browser's Notifications API otherwise) with the question's text.

## What the daemon adds for the app

| Endpoint | Returns |
|---|---|
| `GET /workflows` | the workflows of the repository |
| `GET /supervisor` | the daemon, hosts, policy, live PTY sessions, acceptance figures |
| `GET /report` | the same report as `metator report` |
| `GET /runs/<id>/brief`, `POST /runs/<id>/seen` | `metator run brief` and marking it read |
| `POST /runs` | `{workflow, task, autonomy?, worktree?, parent?, drive?: host}`: `run init`, the worktree's setup, and the drive on that host |
| `WS /ws/inbox` | the inbox, pushed on change |

An answer sent with `origin: "inbox"` is written to the run's activity as such; the Supervisor's 11a tile counts those.
