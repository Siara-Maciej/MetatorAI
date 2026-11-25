# Daemon HTTP API

`metator serve` is a local HTTP server. The desktop app is one client of it; scripts can be others. This page lists every route it has. For what a route does in detail, see the command it matches: most routes answer exactly what that command prints.

## The basics

| | |
|---|---|
| Address | `http://127.0.0.1:4310` by default (`--hostname`, `--port`; `--port 0` takes a free one). The daemon also writes its address into `.metator/daemon.json` of every repository it serves |
| Answers | the same envelope every command prints: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message","hint"}}`, with status 200, or 400 for a usage error, 403 for a call that may not be made, 404 for nothing there, 409 for a write on a stale version |
| Methods | `GET` reads; `POST` changes; `PUT` replaces a document a person edits. A body is JSON, checked before the handler runs |
| A folder | when the daemon serves a folder of repositories, a route that is about one repository takes `?repo=<name>`; `/state` and `/inbox` answer for every repository at once |
| Who calls | a pane's own commands send its token in `x-metator-pane`. Routes that record a person's decision refuse a pane's token with 403: only a call without one, a person's, passes |
| CORS | every answer allows any origin: the daemon listens on localhost only |

`GET /health` answers without the envelope, for a probe: `{"ok":true,"pid":…,"uptimeMs":…,"folder":…}`.

## Overview

| Route | What |
|---|---|
| `GET /state` | every run at a glance, as `metator status`; also the chats (`threads: { open, closed, updatedAt }`) |
| `GET /inbox` | every decision that waits for a person, as `metator inbox`, with the questions of panes under `panes` and the review cards |
| `GET /conflicts` | files two active runs share, as `metator worktree conflicts` |
| `GET /workflows` | the repository's workflows |
| `GET /report` | what the runs cost and gave back, as `metator report` |
| `GET /supervisor` | the supervisor's settings, the host order and which hosts are installed |

## Runs

| Route | What |
|---|---|
| `POST /runs` | a new run, as `metator run new` |
| `POST /runs/:run/start` | its conductor in a pane, as `metator run start` |
| `POST /runs/:run/drive` | a background drive, as `metator run drive --detach`; refused for an escalated run |
| `POST /runs/:run/stop` | stop its drive, as `metator run stop` |
| `POST /runs/:run/continue` | continue the task: its paused panes and the runs nothing drives, as `metator run continue` (a person only) |
| `POST /runs/:run/resume` | an escalated run back at its stage, or at `to` with a `note` for the next agent, driven on, as `metator run resume` |
| `POST /runs/:run/close` | close it, as `metator run close` |
| `POST /runs/:run/answer` | answer a question, as `metator run answer` |
| `POST /runs/:run/approve` | approve a gate or an action, as `metator run approve` |
| `POST /runs/:run/attach`, `/release` | take and give back the keyboard of its session |
| `GET /runs/:run/board` | its plan view, as `metator run board` |
| `GET /runs/:run/activity` | its events, as `metator run activity` |
| `GET /runs/:run/brief`, `POST /runs/:run/seen` | what happened since you last looked, and marking it read |
| `GET /runs/:run/messages`, `POST /runs/:run/message` | messages between runs, as `metator run messages` and `run message` |
| `GET /runs/:run/review` | its change, as `metator review changes` |
| `GET`, `POST /runs/:run/review-notes`; `POST /runs/:run/review-send`, `/review-note-status` | notes on the change, as `metator review notes` |
| `POST /runs/:run/open-editor` | your editor on its worktree, as `metator open` |
| `GET /runs/:run/plan`, `POST /runs/:run/plan/lint` | its plan and the plan's lint |
| `GET /runs/:run/artifacts`, `GET /runs/:run/artifacts/:name` | the files of its run directory |
| `GET /runs/:run/artifact?path=<file>` | one file of its run directory by its path there (`content`, `truncated`); a path that leaves the directory, an absolute path, a link elsewhere and the run's bookkeeping are refused |
| `GET /runs/:run/pty`, `POST /runs/:run/pty-open`, `/pty-close` | its terminal session |
| `POST /runs/:run/close-panes` | close its panes |
| `GET /runs/:run/workers`, `GET /runs/:run/wait`, `POST /runs/:run/delegate`, `/collect` | a conductor's workers: who works, wait for one, start one, collect its result (a conductor's own pane only for `delegate` and `collect`) |

## Panes and sessions

| Route | What |
|---|---|
| `GET /layout` | the workspaces, their tabs and panes |
| `POST /panes` | a new pane |
| `GET /panes/:pane`, `/panes/:pane/state`, `/panes/:pane/wait` | a pane, its state, and a wait until it changes |
| `POST /panes/:pane/answer` | answer a pane's question (`{ "question", "choices", "text", "by" }`); a person only |
| `POST /panes/:pane/continue` | continue a paused pane; a person only |
| `POST /panes/:pane/close`, `POST /panes/close-ended` | close a pane, or every ended pane (`{"runId"}` for one run's) |
| `POST /panes/:pane/split` | a shell beside or below it |
| `POST /panes/:pane/open-editor` | your editor on its directory |
| `POST /panes/:pane/started-run`, `/heartbeat`, `/said` | what a pane's own session reports: the run its chat started, that its agent works, what the person typed into it |
| `POST /tabs/:tab/tree`, `POST /workspaces/:workspace/close` | a tab's layout, closing a workspace |
| `GET /sessions` | the sessions of a task, as `metator session list` |
| `POST /panes/:pane/tell`, `/interrupt` | your words into a session, as `metator session tell` and `interrupt`; the task's main chat or a person only |

## Chats

| Route | What |
|---|---|
| `GET /threads`, `GET /threads/:id` | the chats with their tasks, and one thread, as `metator thread list` and `thread show` |
| `POST /threads` | a new chat and its terminal, as `metator thread new` |
| `POST /threads/:id/summary`, `/close`, `/reopen` | as `metator thread summary`, `close` and `reopen` |

## Backlog and options

| Route | What |
|---|---|
| `GET /issues`, `GET /issues/:issue` | the backlog and one task, as `metator issue list` and `issue show` |
| `POST /issues` | add a task |
| `POST /issues/:issue/decide`, `/edit`, `/close`, `/drop`, `/start` | decide a proposal, edit, close, drop, start a run |
| `POST /issues/:issue/analyze`, `/plan` | **Analyse** and **Make plan** |
| `POST /issues/from-plan` | **Create Backlog item** from a plan |
| `GET /options`, `GET /options/schema`, `POST /options/:key` | every option with its value and source, their schema, and setting one |
| `GET /scratch`, `POST /scratch/drop`, `/scratch/forget` | the debug changes, as `metator scratch list`, `drop` and `forget` |

## Reviews

| Route | What |
|---|---|
| `POST /reviews` | review a pull request from its link, as `metator review open` |
| `GET /reviews`, `GET /reviews/:id` | the watched requests and one of them, as `metator review list` and `review show` |
| `POST /reviews/:id/rereview`, `/unwatch`, `/dismiss` | **Re-review**, **Stop watching**, and **No** on its card |
| `POST /reviews/:id/approve` | approve it at the code host; a person only |
| `GET /mrs`, `GET /mrs/:request` | reviews of your own requests, as `metator mrs list` and `mrs show` |
| `POST /mrs/:request/analyse`, `/send`, `/resolve` | as `metator mrs analyse`, `mrs send` (`{ only, skip }`) and `mrs resolve` |

## Systems

| Route | What |
|---|---|
| `GET /system/plans`, `GET /system/plans/:plan` | the system plans and one of them |
| `POST /system/plans/:plan/lint` | its lint |
| `POST /system/plans/:plan/approve` | approve it; a person only |
| `POST /system/plans/:plan/steps/:step/retry` | **Retry this step**; a person only |
| `POST /system/plans/:plan/steps/:step/plan` | **Plan this step** |
| `GET /system/map`, `PUT /system/map` | the system map, and saving it; a person only |
| `POST /system/discover` | what the code shows that the map lacks; with `write`, a person only |

## WebSockets

| Path | Sends |
|---|---|
| `/ws/state`, `/ws/inbox` | the overview or the inbox whenever it changes |
| `/ws/activity/<run>` | a run's activity as it happens |
| `/ws/pty/<run>`, `/ws/pane/<pane>` | a terminal: its output out, your input and resizes in |
| `/ws/events` | which topics changed, never their data: read them again with their `GET` |

### `/ws/events`

One socket for the whole daemon tells a client what to read again, so it does not have to poll. It sends `{"type": "hello", "epoch": "…", "seq": 12}` when it connects, then `{"type": "changed", "epoch": "…", "seq": 13, "topics": ["inbox", "state"]}` whenever something changed: topics sorted, each once, gathered over 50 ms. `seq` goes up by one per message; `epoch` is new each time the daemon starts. After every `hello`, read again everything you show: you may have missed changes while you were away.

| Topic | Read again |
|---|---|
| `state` | `GET /state` |
| `inbox` | `GET /inbox` |
| `layout` | `GET /layout`: panes, and whether each asks, works, idles or has exited |
| `threads` | `GET /threads` |
| `options` | `GET /options` |
| `plans` | `GET /system/plans`, a run's `GET /runs/<run>/plan`, `GET /system/map` |
| `reviews` | `GET /reviews`, `GET /mrs` |
| `backlog` | `GET /issues` |
| `activity:<run>` | `GET /runs/<run>/activity` |

A daemon that serves a folder adds the repository to `layout`, `options`, `plans`, `backlog` and `activity` after an `@` (`layout@shop`, `activity:<run>@shop`): read them with `?repo=shop`. A change made by another process (a detached drive, an agent's `metator` command) arrives within the daemon's `--poll-ms`; a topic may arrive for a change you already read, and reading again is always safe.
