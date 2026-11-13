# The app

The desktop app is where you work with MetatorAI. It is a window over a local daemon, `metator serve`, which holds the runs, their terminals and the questions that wait for you. This page shows how to start the app and what each screen is for.

Everything the app does is also a `metator` command. Each page of this section shows the app first and the commands after it, under "From a terminal".

## Start it

The repository must be set up once with `metator setup` ([First run](../guide/first-run.md)). Then start the daemon in the repository, or in a folder that holds several repositories:

```bash
metator serve
```

It listens on `http://127.0.0.1:4310` and runs until you stop it. `--port <n>` picks another port. One repository has one daemon: a second `metator serve` there is refused and names the address and the process id of the first. A daemon for another repository needs its own port (`metator serve --port <other>`).

Then open the app. The installers are built by the `desktop` workflow of the MetatorAI repository on GitHub, as the artifacts `metatorai-desktop-windows-x64`, `metatorai-desktop-macos-universal` and `metatorai-desktop-linux-x64`. From a clone of MetatorAI you can run the window directly:

```bash
cd packages/desktop && bun run tauri dev     # needs Rust and the platform's webview
```

The app looks for the daemon at the default address. The word on the right of the top bar reads **connected** when it found it.

When nothing answers at that address, it reads **no daemon** and the main area shows one panel on every screen: what is wrong, the command `metator serve`, a field with the daemon's address, and **Retry**. If your daemon listens elsewhere, type its address in the field and click **Retry**; the app remembers it. The app also tries again by itself every two seconds, and the screen you were on returns as soon as the daemon answers. The same address is in **Settings**, group **app**, as **daemon url** ([Your settings](./settings.md#daemon-address-and-your-name)).

![The app with nothing to decide: the sidebar and the Inbox](../public/screens/inbox-empty.png)

## The window

A thin bar on top shows your name, **you: alice**, a **?** that lists the keys, and whether the daemon answers. The app asks for your name once, in a dialog, the first time you answer, attach or decide something; a click on it changes it.

Everything else is two parts: the sidebar on the left, which stays on every screen, and the place you chose. In a window narrower than about 1000 pixels the sidebar is hidden; the button **Runs · N** in the top bar opens it over the screen.

## The sidebar

The sidebar is the whole dashboard. Every row is built the same way: the state's glyph, a name, the state's word at the right, and one dim line under the name.

**Needs you · N** is on top: every question that waits on a card, every run whose agent asks on its own terminal, and every escalated run. A click on a row opens its decision in the Inbox ([Answer questions](./inbox.md)); a row marked `terminal` opens the run on the pane that asks. The number in the heading is the number of rows.

**Runs · N** follows, one group per repository when the daemon serves a folder. A run's dim line is its stage, its AI host and the time since it started; a step of a run that was split sits under its parent, with `step 2/3`. A run with more than one pane lists its panes under it. A click on a run opens its page; a click on an escalated run opens its card. Finished runs fold into **Finished · N** at the end.

A run reads one of five words, and the mark of a group is the strongest of its runs:

| Word | Means |
|---|---|
| `needs you` | it asks: on a card in the Inbox, or in its terminal |
| `escalated` | it stopped and needs work from you |
| `working` | an agent works on it |
| `done` | it finished and you have not opened it since; once you open it, it is `idle` |
| `idle` | nothing happens and nothing is asked: stopped, aborted, or finished and seen |

The app remembers which finished runs you opened in the window's own storage; another browser or computer starts with every finished run as `done`.

Under the runs are the places that are not a run:

| Place | Shows |
|---|---|
| **Terminals** | a tab per run or shell, with the agents' terminals and your own in split panes ([Terminals](./desktop.md)) |
| **Backlog** | tasks for later: agents' proposals and your own ([Plan and backlog](./plan.md)) |
| **Reviews** | reviews of your pull requests, the proposed replies, and the buttons that send them ([Answer a review](./reviews.md)) |
| **Overview** | the daemon with its figures, hosts and settings, and under **Dependencies** what links the runs |
| **Settings** | the options ([Your settings](./settings.md)) |

At the bottom, **+ New run** opens a pane with the agent, and you tell it what you want; **Form…** beside it opens a form where you choose the workflow, host, autonomy and worktree yourself ([Start a task](./start.md)). With no run at all the main area offers the same: a field **Describe a task** with **Start**, and **Use the form**.

When the daemon serves a folder of repositories, **Terminals**, **Backlog**, **Reviews**, **Overview** and **Settings** show one repository at a time. Each has a **repository** select at the top; the choice is shared by these places and remembered. The page of a run always uses the run's own repository.

## The page of a run

A run has one page with five tabs. The head is the same on every tab: the task, the run id, the tabs, what the run is (workflow, autonomy, host, ports, age) and its stages in one line. An escalated run shows why it stopped under the head, with **Resume** and **Close run…**; a finished one says how it ended.

| Tab | Key | Shows |
|---|---|---|
| **Overview** | `o` | what happened since you left, the question that waits with its answers, the run's change |
| **Terminal** | `t` | the run's live session, who types, its panes, its applications and links ([Sessions and worktrees](./sessions.md)) |
| **Plan** | `p` | the plan's steps with their state, what comes next, the artifacts ([Plan and backlog](./plan.md)) |
| **Changes** | `d` | the files the run changed, their diffs and your notes ([Read the change](./changes.md)) |
| **Activity** | `l` | everything the run did: the time, the type, the source and what happened |

### Overview of a run

When you come back to the window after ten minutes away and a run's page is open, its **Overview** opens first. It counts the stage transitions, the decisions taken and the errors since you left, lists the events by stage, and shows what the run needs from you now, with the answers as buttons. The files it counts are the run's change, the same files the **Changes** tab lists.

![The overview of a run: four counters, the events since you left, and the question that waits](../public/screens/briefing.png)

**Open terminal and attach** goes to the Terminal tab and gives you the keyboard. **Mark as read** starts the next "since you left" from now.

## Overview

**Overview** has two parts.

**Daemon** is the daemon's own view. Four tiles show the median time from a question to its answer, the share of answers given from the decision card without opening the run, how many runs the daemon started again in the last 24 hours, and how many reminders it typed to an idle agent. Below is a table of the open runs with their host, who works, state, terminal and last activity; a click on a run's name opens it. The side column shows how the daemon looks after runs (the waiting limit, restarts, the host order) and, under **AI hosts**, each host with **installed** or **not installed**. The daemon looks the hosts up each time, so a host you install while it runs is found without a restart. You change the settings in `metator.config.yml` ([Configuration](../reference/configuration.md#supervisor)).

**Dependencies** is the graph. Each repository is a lane and each open run a card with its task, stage, AI host and who works on it (the agent or you). A click on a card opens the run. An arrow joins a parent run to its child. A dashed line joins two runs that exchanged a message or changed the same file. The **Links** box lists those pairs. For a shared file it says which run to merge first, and **Notify both** sends each of the two runs a message about the file.

## Keys

`?` lists every key, and typing in its field filters the list. Single-letter keys work when the cursor is not in a text field and no Ctrl, Cmd or Alt is held, so the system's own shortcuts stay what they are.

| Key | Does |
|---|---|
| `n` | a new run: the pane with the agent |
| `g` | the next run that needs you |
| `j` `k`, `↓` `↑` | move in a list: the decisions, the tasks, the steps, the files |
| `o` | the overview of the run, from a decision or on a run's page |
| `t` `p` `d` `l` | on a run's page: Terminal, Plan, Changes, Activity |
| `a` `c` | on a run's Terminal tab: attach, release to the agent |
| `e` | on a run's page: open it in the editor |
| `Esc` | closes a dialog, also from a field, and the sidebar's drawer |

The keys of **Terminals** come after a prefix ([Terminals](./desktop.md#keys)).

## Notifications

A question that was not in the queue before raises a system notification, "MetatorAI needs you", with the question's text. The first time, the system asks whether the app may notify you. On **Terminals**, a waiting question of an open tab also shows as a toast with the first two lines of the question. A click on the toast opens the question's decision card in the Inbox; for a permission prompt of the host, which is answered in the terminal, it opens the tab and gives you the keyboard of the run's main pane. The `✕` on the toast hides it; the question stays in the Inbox.
