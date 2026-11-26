# The app

The desktop app is where you work with MetatorAI. It is a window over a local daemon, `metator serve`, which holds the runs, their terminals and the questions that wait for you. This page shows how to start the app and what each screen is for.

Everything the app does is also a `metator` command. Each page of this section shows the app first and the commands after it, under "From a terminal".

## Start it

The repository must be set up once with `metator setup` ([Start with one repository](../guide/first-run.md)). Then start the daemon in the repository, or in a folder that holds several repositories ([Start with many repositories](../guide/many.md)):

```bash
metator serve
```

To start it in the background and get its address back at once, add `--ensure`: `metator serve --ensure` starts the daemon when none serves the repository and answers `{"url": …, "pid": …, "started": true}`; when one already runs, it answers with that one and `"started": false`. Its output goes to `.metator/daemon.log`.

Without `--ensure` it listens on `http://127.0.0.1:4310` and runs until you stop it. `--port <n>` picks another port. One repository has one daemon: a second `metator serve` there is refused and names the address and the process id of the first. A daemon for another repository needs its own port (`metator serve --port <other>`).

Then open the app ([Get the desktop app](../guide/desktop-app.md)). The app looks for the daemon at the default address. The word on the right of the top bar reads **connected** when it found it.

When nothing answers at that address, it reads **no daemon** and the main area shows one panel on every screen: what is wrong, how to start the daemon (in the installed app a field for the folder, below; in a browser the command `metator serve`), a field with the daemon's address, and **Retry**. If your daemon listens elsewhere, type its address in the field and click **Retry**; the app remembers it. The app also tries again by itself every two seconds, and the screen you were on returns as soon as the daemon answers. The same address is in **Settings**, group **app**, as **daemon url** ([Your settings](./settings.md#daemon-address-and-your-name)).

### The app starts the daemon itself

You do not have to run `metator serve` before you open the installed app. The first time, the app shows a panel with a field **folder to serve**: type the path of your repository, or of a folder that holds several, and click **Start the daemon**. The app runs `metator serve --ensure` for that folder, connects to the daemon it started (or to the one that already ran there), and remembers the folder. From then on it starts the daemon for that folder every time it opens, and again by itself when the daemon went away.

The daemon keeps running after you close the app, because the agents' terminals live in it; stop it with `kill <pid>` (the pid is in `.metator/daemon.json`). The app needs the `metator` program: it uses `METATOR_BIN` when that is set, and otherwise `metator` from your `PATH` (on macOS and Linux as your login shell sees it). When the start does not work, the panel says why under the field.

![Home before any work: Describe a task with Start and Use the form, and + New chat at the bottom of the sidebar](../public/screens/real/real-01-home-empty.webp)
*Home before the first chat.*

## Three levels

The app is built so that the first thing you see is simple, and the details come only when you open something:

1. **Tasks**: what is going on, and does anything wait for me. The sidebar, Home and the Board show each task with its name, one state word, its progress and how many of its steps need you.
2. **A task**: how this task goes. Its page has its flow, its steps by repository and the one thing to decide.
3. **A step**: what the agent does exactly. Its page has its terminal, its changes, its activity, its plan and its artifacts.

On the first level a thing reads one of five words:

| Word | Means |
|---|---|
| `needs you` | it asks: a decision on Home, or a question in its terminal |
| `working` | an agent works on it |
| `blocked` | it stands still and does not ask: it escalated, it waits for another step, or nothing drives it |
| `to do` | a backlog task nobody started yet: nothing is wrong with it |
| `done` | it finished, also when it was closed without its work |

A blocked thing says why in one line on its task's page and its own: `escalated at build: …`, `waits for price-endpoint`, `nothing drives it: Open a session`. The finer words of a run or a pane (`asks`, `idle`, `exited`, `aborted`, `escalated`) are in its terminal and in **Details** on its page.

## The window

A thin bar on top shows your name, **you: alice**, a **?** that lists the keys, and whether the daemon answers. The app asks for your name once, in a dialog, the first time you answer, attach or decide something; a click on it changes it.

Everything else is two parts: the sidebar on the left, which stays on every screen, and the place you chose. In a window narrower than about 1000 pixels the sidebar is hidden; the button **Runs · N** in the top bar opens it over the screen.

## The sidebar

The sidebar is the first level. Every row is built the same way: the glyph of one of the five words, a name, the word at the right, and one dim line under the name. A row has no run id, no host and no age: those are on the run's page, under **Details**.

**Needs you · N** is on top: how many questions, terminal questions and escalated runs wait for you. A click opens Home, which shows them one at a time ([Home and the Board](./inbox.md)).

**«** beside it folds the sidebar to a narrow column of glyphs: **?** with how many things need you, one glyph per open chat and per task without a chat in its state's colour, the places (Board, Terminals, Backlog, Reviews, Settings) and **+** for a new chat. Each is named in full on hover; a click does what its row does. **»** unfolds it. The window remembers which you chose.

The chats follow, and the sidebar is one tree: a chat, its tasks, their repositories, their steps.

- **A chat** (a thread) is one topic you talk about with the agent. Its row has the chat's title, one word and how many tasks it holds (`2 tasks`). The word is its most urgent task's (`needs you`, then `blocked`, then `working`, then `done`), `needs you` while the chat itself asks you something, and `chat` while no task was started in it. Chats that need you come first, then the one that changed last. A click opens the chat: its terminal fills the main area ([Chats and the three ways](./start.md)). **⋯** on its row offers **Close chat**, or **Reopen chat** for a closed one.
- **A task** under its chat is a run the chat's agent started, with everything that run started. A task is a system task (a system plan with its system run and its steps), a run that started child runs, or a run of its own. Its row has one state word, its progress (`3/6`), how many of its steps need you (`2 need you`) and how many are blocked; tasks that need you come first. **▸** unfolds a task into its own tree: the repositories it works in, each with its steps and child runs and their word, steps not started too, with what they wait for (`not started · waits for api-model, api-endpoint`). A run of its own unfolds into its panes. A click on a task opens its page; a click on a step opens the step's page, or, when the step asks on a card, that decision on Home.

**Without a chat · N** holds the tasks no chat started: a run from the form, from an intake rule, from `metator run new` in a terminal, or from CI. It shows only while there is one.

**Closed (N)**, folded, holds the chats you closed. Closing a chat ends its terminal and never stops its tasks: they go on, and stay under that chat. **▸** unfolds the group; a closed chat's row reads `closed`. Nothing is ever deleted.

Finished tasks are hidden. **Show finished (N)**, at the end of each chat and of **Without a chat**, shows them; a finished run reads `done`, and its line says how it ended (`done`, `aborted`), with the reason on hover.

![The sidebar: the chats Mug discount 3+ and SKU lookup and pricing with its two finished tasks, and a task without a chat](../public/screens/real/real-08-sidebar-threads.webp)
*The sidebar: each chat with the tasks it started.*

Under the chats are the places that are not a task:

| Place | Shows |
|---|---|
| **Board** | every task by phase: To do · Planning · In progress · Review · Done ([The Board](./inbox.md#the-board)) |
| **Terminals** | the terminals of a task side by side: its main chat and a session per repository ([Terminals and sessions](./sessions.md)) |
| **Backlog** | tasks for later: agents' proposals and your own ([Plan and backlog](./plan.md)) |
| **Reviews** | the pull requests MetatorAI watches for you and your own, each with one word ([Reviews](./reviews.md)) |
| **Settings** | the options, and under it **System**: the daemon, the dependencies, the system map ([Your settings](./settings.md)) |

At the bottom, **+ New chat** (key `n`) starts a chat: a new thread with its own terminal, where you tell the agent what you want; **Form…** beside it opens a form where you choose the workflow, host, autonomy and worktree yourself, and the run it starts is **Without a chat** ([Full runs](./runs.md#from-the-form)). With no run at all the main area offers the same: a field **Describe a task** with **Start**, which starts a chat named after your words, and **Use the form**.

When the daemon serves a folder of repositories, the top bar shows how many (**3 repositories**), and **Terminals**, **Backlog**, **Reviews** and the parts of **Settings** show one repository at a time. Each has a **repository** select at the top, which also lists a repository's worktrees in the folder; the choice is shared by these places and remembered, and **+ New chat** opens its chat there. The page of a run always uses the run's own repository ([Folder of repositories](../many/index.md#the-app-on-a-folder)).

## Home

**Home** is the first screen. It shows one decision at a time: a big card with the question, or the plan to approve, and its answers. Above it, **3 waiting** says how many wait, with **‹ Previous** and **Next ›** (also `k` and `j`). Everything else about the decision is folded under **Details**: its ids, the evidence, what happened since you left, what each answer does, and the command your answer amounts to ([Home and the Board](./inbox.md)).

With nothing to decide, Home lists the open tasks in short, with their word and progress (a task started in a chat has the chat's title before its name, dim: **Invoice discount · Add the discount to the invoice**), the runs nothing drives with **Open a session** and **Drive in background**, and **Describe a task** to start a new one.

## The page of a task

A system task, or a run that started child runs, has a page of its own: how the task goes. Its head has the task's name, its word, a bar of its steps done (`3 of 6 steps done`) and, when it is blocked, why. Its tabs are **Overview**, **Changes** and **Activity**; its steps have the terminals.

Its **Overview** has the one thing to decide in the task, if any: the decision card of the first of its steps that asks, the same card as on Home. Under it, for a system task, the plan's flow and its steps by repository ([A system run's plan](./plan.md#a-system-runs-plan)); for a run with child runs, its child runs by repository. A click on a step opens the step's page.

## The page of a step

A step, a child run and a run of its own have the page of a step: what the agent does exactly. A step's page starts with **Task › step**, which leads back to its task. The head has the name, the word, a bar of its stages done and the stage it is at now. **Details** in the head folds what the run is: its id, repository, workflow, autonomy, host, ports and age, its finer state, and every stage in one line.

| Tab | Key | Shows |
|---|---|---|
| **Overview** | `o` | the question that waits with its answers, the step's plan read-only, its artifacts and change, what happened since you left |
| **Terminal** | `t` | the run's live session, who types, its panes, its applications and links ([Terminals and sessions](./sessions.md#the-terminal-tab-of-a-run)) |
| **Changes** | `d` | the files the run changed, their diffs and your notes ([Read the change](./changes.md)) |
| **Activity** | `l` | everything the run did: the time, the type, the source and what happened |

An escalated run shows why it stopped under the head, with **Resume** and **Close run…**; one nothing drives offers **Open a session** and **Drive in background**; one that asks on a card with no session open says its question waits on Home and still offers **Open a session**, to talk to its conductor (the question stays on its card); a finished one says how it ended. **its card on Home ›** beside its question opens exactly that decision. The old address of a run's Plan tab (`#/run/<run>/plan`) opens its Overview.

### Overview of a step

When you come back to the window after ten minutes away and a run's page is open, its **Overview** opens first. It counts the stage transitions, the decisions taken and the errors since you left, lists the events by stage, and shows what the run needs from you now, with the answers as buttons. The files it counts are the run's change, the same files the **Changes** tab lists.

![A step's Overview: the question that waits, its plan, its artifacts and, below, what happened since you left](../public/screens/overview.png)

**Open terminal and attach** goes to the Terminal tab and gives you the keyboard. **Mark as read** starts the next "since you left" from now.

## Settings

**Settings** has two parts: **Options**, your options and the repository's, and **System**: the daemon's own view, the dependencies between runs and the system map. Both are on [Your settings](./settings.md).

## Keys

`?` lists every key, and typing in its field filters the list. Single-letter keys work when the cursor is not in a text field and no Ctrl, Cmd or Alt is held, so the system's own shortcuts stay what they are.

| Key | Does |
|---|---|
| `n` | a new chat: a thread with its own terminal and the agent |
| `g` | the next run that needs you |
| `j` `k`, `↓` `↑` | on Home, the next or the previous decision; elsewhere, move in a list: the tasks, the steps, the files |
| `o` | the overview of the run, from a decision or on a run's page |
| `t` `d` `l` | on a step's page: Terminal, Changes, Activity |
| `Backspace`, `Esc` | on a task's board: back to all tasks |
| `a` `c` | on a run's Terminal tab: attach, release to the agent |
| `e` | on a run's page: open it in the editor |
| `Esc` | closes a dialog, also from a field, and the sidebar's drawer |

The keys of **Terminals** come after a prefix ([Terminals and sessions](./sessions.md#keys)).

## Notifications

A question that was not in the queue before raises a system notification, "MetatorAI needs you", with the question's text. The first time, the system asks whether the app may notify you. On **Terminals**, a waiting question of an open tab also shows as a toast with the first two lines of the question. A click on the toast opens the question's decision card on Home; for a permission prompt of the host, which is answered in the terminal, it opens the tab and gives you the keyboard of the run's main pane. The `✕` on the toast hides it; the question stays on Home.

## The Board

**Board** shows every task by phase, in five columns: To do, Planning, In progress, Review and Done ([The Board](./inbox.md#the-board)).

![The Board: a blocked task in To do with Start a run, empty Planning, In progress and Review, and three tasks in Done](../public/screens/real/real-08-board.webp)
*The Board: every task in the column of its phase.*
