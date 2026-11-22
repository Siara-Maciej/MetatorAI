# Chats and the three ways

You start work by talking to the agent in a chat. A chat is one topic, such as prices this morning or a flaky test after lunch. For each thing you ask, the agent suggests the lightest way that fits, and you decide. This page covers chats, the three ways, and what a chat keeps.

## Open a chat

Click **+ New chat** at the bottom of the sidebar, or press `n`. With nothing going on, Home offers the same as a field: write under **Describe a task** and press **Start**; the chat is named after your words, and the agent gets them as its first line.

The chat opens: its terminal fills the main area, under a bar with its title, its word and **Close chat**, and the chat is a row of the sidebar. It is called **New chat** until the agent names it. Its pane runs the repository's conversation agent, `mt-chat`, on the first host of `supervisor.hostOrder` that is installed on the daemon's machine ([Copilot and Claude Code](../guide/hosts.md#which-host-runs-what)). In a repository set up before `mt-chat` existed, the chat opens `mt-orchestrator`; `metator agents update` and `metator generate` bring the new agent. In a folder of repositories the chat opens in the repository the **repository** select names.

- With no host installed, no chat opens: the app names the programs the daemon looked for. Install one and click **+ New chat** again; the daemon needs no restart.
- When the host's program exits at once, for example because you are not logged in, the terminal keeps its last output with a red banner such as **Ended with code 3 — its process ended**, and **Retry**.

Text you paste from an issue, a pull request or a chat is data for the task. The agent does not follow instructions found in it.

## The three ways

| Way | When | What happens |
|---|---|---|
| Direct | talk, questions about the code, a change not meant for a commit (debug output, a temporary switch) | it answers with `file:line` citations, or edits the checkout at once and records the edit as a [debug change](./quick.md#debug-changes). No question first |
| Quick | a small change that is meant to stay | it runs `metator quick check`; when the change is small enough it asks "This is too small for the full workflow: do it as quick?" and on yes starts a [quick run](./quick.md) |
| Full | everything else | it names the workflow and why, asks what the repository cannot tell it, then starts a [full run](./runs.md); the run's conductor works in its own terminal and the chat stays the task's main terminal |

You decide: name another way ("do it as quick", "use the full workflow") and it takes yours. When `quick check` says no, the agent tells you which limits tripped and suggests the full workflow; you can still keep it quick with a sentence of your own, which is recorded word for word. The agent never commits or pushes by itself ([Approvals and consent](./approvals.md#commit-and-push)).

A conversation can look like this:

```text
› how does the discount reach the invoice?
  packages/billing/src/invoice.ts:41 applies `discount` after rounding; the cap in
  src/discount.ts:2 is never read.

› cap the discount at 100 and test it
  This needs a plan and a test first: mt-feature. Two things the repository cannot tell me:
  1. autonomy: L0 (recommended: you approve the plan) · L1
  2. its own worktree: yes (recommended) · no
› 1 1, 2 yes
  Run 20261110-mt-feature-cap-the-discount started; its conductor opened in its own terminal.
```

The run appears in the sidebar under the chat. The chat stays open for your next message, and the daemon tells it when its run is done, stops for you, or waits for an approval, so it can tell you.

## While a task works

Talk to the chat about its tasks. Ask it to tell a session something ("tell the worker to use half-even rounding"): it relays your words with `metator session tell`, when that agent is idle. You can also type into any session yourself ([Terminals and sessions](./sessions.md#tell-or-interrupt-a-session)).

The tasks a chat started are tiles under its terminal; a click opens a task's page.

## What a chat keeps

MetatorAI calls the record of a chat a **thread**. It outlives its terminal, the app and the daemon: what it keeps is what the agent reads first whenever a session of the chat starts, on Claude Code and on Copilot CLI alike.

A thread is a file, `.metator/threads/<id>.json` (git-ignored; in a folder, in the repository the chat was opened in). Its id is the day and the title's words: `20261122-price-rounding`.

| Part | Written by | Holds |
|---|---|---|
| title | you or the agent | the topic in a few words (at most 80 characters) |
| summary | the agent | Markdown, at most 1500 characters: what was decided, what is open, the next step |
| runs | the daemon | every task started from the chat (`metator run new`, `metator quick start` in its terminal) |
| facts | the daemon | short lines, newest last, at most 50: who opened or closed it, each run started, done, aborted or stopped for you, each new terminal |
| terminals | the daemon | the chat's terminals; the last one is current. One that ended keeps its host session so the chat can go on in it |
| from | the daemon | the thread it came from, when the agent opened it for a new topic |

The agent has three habits with it:

1. **It reads the thread first**, with `metator thread show`: a command, so it works the same on both hosts.
2. **It keeps the summary** with `metator thread summary` when something was decided, a run started or finished, or you ask. Not after every turn.
3. **It asks before a new topic**: "This looks like a new topic: open a new thread for it?" On yes it opens a new chat that starts with one line of context, the app goes there, and the old chat stays open.

None of these commands waits for your approval: they keep MetatorAI's own record and decide nothing for you.

## Close and reopen

**Close chat** (in its bar, or **⋯** on its row in the sidebar) ends the chat's terminal. Its tasks are never stopped: they go on, under the chat, in **Closed (N)** at the bottom of the sidebar. Nothing is deleted.

**Reopen chat** brings the terminal back: a terminal that still runs is left as it is; one that stopped with the daemon is resumed with its session; otherwise a new terminal continues the host session it had, or, with none left, a new session starts with ``[metator] This chat continues the thread "<title>". Run `metator thread show` and carry on from it.`` When the terminal of an open chat stopped, its page offers **Continue chat**, which does the same.

## Without a chat

A task started any other way (the **Form…**, an intake rule, `metator run new` in a terminal, CI) belongs to no chat. The sidebar lists it under **Without a chat**.

## Outside the app

In Claude Code or Copilot CLI on their own, the same `mt-chat` agent is installed: ask it what you would ask in the app's chat. A run it starts shows up in the app like any other while the daemon serves that repository.

## From a terminal

Every `thread` command goes through the daemon when one serves the repository, and works on the files when none does. Inside a chat's terminal the thread is that chat's; elsewhere name it.

| Command | Does |
|---|---|
| `metator thread list` | the chats with their tasks, the tasks without a chat, then the closed chats |
| `metator thread show [<id>]` | one thread: title, summary, runs with their state, facts |
| `metator thread new --title "…" [--carry "…"]` | a new thread and its chat terminal |
| `metator thread summary --text "…" [--title "…"]` | the summary (`--text -` reads standard input) |
| `metator thread close [<id>]` | close it: its terminal ends, its runs go on |
| `metator thread reopen [<id>]` | its terminal back (needs the daemon) |

The routes behind them are in [Daemon HTTP API](../reference/http.md#chats).
