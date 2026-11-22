# Chats and threads

A chat is one topic you talk about with the agent: prices this morning, a flaky test after lunch. MetatorAI calls the record of a chat a **thread**. A thread outlives its terminal, the app and the daemon: what MetatorAI keeps of it is what the agent reads when a session of the chat starts, on Claude Code and on Copilot CLI alike. The app shows chats in its sidebar ([Terminals](./desktop.md#chats)); this page says what a thread keeps, what the agent does with it, and the commands behind it.

## What a thread keeps

A thread is a file in the repository whose daemon serves the chat, `.metator/threads/<id>.json` (git-ignored, like all of `.metator/`; in a folder of repositories, the repository the chat was opened in). Its id is the day and the title's words: `20261122-price-rounding`.

| Part | Written by | Holds |
|---|---|---|
| title | you or the agent | the topic in a few words (at most 80 characters). "+ New chat" starts as **New chat**; the agent names it once the topic is clear |
| summary | the agent | Markdown, at most 1500 characters: what was decided, what is open, the next step |
| runs | the daemon | every task started from the chat (`metator run new`, `metator quick start` in its terminal); a run's own steps stay under it |
| facts | the daemon | short lines, newest last, at most 50: who opened or closed it, each run started, done, aborted or stopped for you, each new terminal of the chat |
| terminals | the daemon | the chat's terminals; the last one is current. A terminal that ended keeps its host session so the chat can go on in it |
| from | the daemon | the thread it came from when the agent opened it for a new topic |

Nothing is deleted by itself: a closed thread stays, under **Closed** in the sidebar.

## What the agent does with it

The chat's agent, `mt-chat`, has three habits (its instructions are `metator/agents/mt-chat.md`, installed by `metator setup`):

1. **It reads the thread first.** Its first action in a session is `metator thread show`: the title, the summary, the facts and the runs with their state. This is a command, not a host's own start-of-session feature, so it works the same on both hosts.
2. **It keeps the summary.** When something was decided, a run started or finished, or you ask, it runs `metator thread summary --text "…"`. Not after every turn: a summary costs part of your limit.
3. **It asks before a new topic.** When you turn to something unrelated it asks: "This looks like a new topic: open a new thread for it?" On yes it runs `metator thread new --title "…" --carry "<one line of context>"`. The daemon opens a new chat whose first message is that line, the app goes there, and the old chat stays open.

None of these commands waits for your approval: they keep MetatorAI's own record and decide nothing for you.

## Closing and reopening

Closing a chat ends its terminal. The tasks started in it are never stopped; they go on, and stay listed under the chat.

Reopening brings the terminal back:

- a terminal that still runs is left as it is;
- a terminal that stopped with the daemon is resumed where it was, with its session;
- a closed chat gets a new terminal that continues the host session it had;
- when no session is left to continue, a new session starts and its first message says what it continues: ``[metator] This chat continues the thread "<title>". Run `metator thread show` and carry on from it.``

When the daemon restarts, the terminals of open chats come back by themselves, as every agent's terminal does ([Sessions and worktrees](./sessions.md)).

## Without a chat

A task started any other way (the form, an intake rule, `metator run new` in a terminal, CI) belongs to no thread. The sidebar lists it under **Without a chat**, and `metator thread list` prints it there. Nothing is written for it: it is every task no thread lists.

## Commands

Every `thread` command goes through the daemon when one serves the repository, and works on the files when none does. Inside a chat's terminal the thread is that chat's; elsewhere name it (`--thread <id>`, or the id after `show`, `close`, `reopen`).

| Command | Does |
|---|---|
| `metator thread list` | the chats with their tasks, the tasks without a chat, then the closed chats |
| `metator thread show [<id>]` | one thread: title, summary, runs with their state, facts |
| `metator thread new --title "…" [--carry "…"]` | a new thread and its chat terminal (without a daemon: the thread only, with `noPane` saying why) |
| `metator thread summary --text "…" [--title "…"]` | the summary (`--text -` reads it from standard input, so a here-document works) |
| `metator thread close [<id>]` | close it: its terminal ends, its runs go on |
| `metator thread reopen [<id>]` | its terminal back (needs the daemon) |

The app reads the same through the daemon: `GET /threads` gives the sidebar's tree, `GET /threads/<id>` one thread, and `POST /threads`, `/threads/<id>/summary`, `/close` and `/reopen` change one. The state (`GET /state`) carries `threads: { open, closed, updatedAt }`, which changes whenever a thread does. See [Documents](../reference/documents.md) for the file.
