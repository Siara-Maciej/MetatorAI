# Answer questions

A run stops when a decision belongs to you. Every open question of every run is in one queue, the inbox. This page shows how to read it and answer, in the app and from a terminal.

## What stops a run

| Source | When | What your answer does |
|---|---|---|
| `gate` | an approval, a stage that needs a person: plan approval, delivery, publishing review comments | Approve continues; Reject sends the run back with your reason |
| `agent` | an agent cannot decide from the code and asks | the answer goes back to the same agent, which continues |
| `permission` | an agent wants to run a tool that is not pre-approved | Allow runs the call; Deny refuses it, with your reason |

An agent works without asking when it runs the MetatorAI commands its definition names, reads or searches the repository, writes its artifacts into the run directory, or edits files inside the run's own worktree. Anything else asks. A push always asks.

## The Inbox screen

**Inbox** is the first screen of the app. The column **Needs you** lists the open decisions. Questions that a live drive waits on come first, because that run stands still until you answer. The rest follow, oldest first. When the daemon serves a folder of repositories, the queue covers all of them.

![The Inbox with the decision card of an approval: the goal, what happened since you left, three options and the answer buttons](../public/screens/inbox.png)

Each row shows the kind (`APPROVAL`, `PERMISSION` or `QUESTION`), how long the question has waited, the first two lines of its text and its run. A click on a row opens its decision card on the right:

| Part | What it tells you |
|---|---|
| Header | the question id, its kind, the stage, the run and the agent |
| Chips | whether the decision can be taken back, how many files it touches, how long it has waited |
| **Goal** | the run's task |
| **Since you left** | what happened since your last answer |
| **Proposal and evidence** | the stages done so far, the artifacts to read, the checks that ran |
| **Options** | each option with what it leads to; one may be marked **RECOMMENDED** |

The card is assembled from the run's files when the question is asked. No model writes it. The recommendation comes from a fixed rule: for example, Approve is recommended at an approval when the stage before it passed.

To answer:

1. Click an option. The recommended one is chosen when the card opens. A question that allows several answers says **choose one or more**: each click adds or removes an option, and nothing is chosen for you.
2. The field under the options is **Note (optional)**. With Reject or Other it becomes **Reason for Reject (required)**, and the answer cannot be sent until you have written it.
3. Click the first button, or press `Enter`. The button carries the options you chose, such as **Approve**. The button next to it sends the first of the other options in one click; when that option is Reject, it chooses it and puts the cursor in the reason field.

The first time you answer, the app asks for your name in a dialog and remembers it.

The line under the buttons shows the command your answer amounts to. **Changes** opens the run's change ([Read the change](./changes.md)) and **Open session** (or the key `o`) the run's **Session** screen, when you want to look before you decide. The key `g` moves to the next item of the queue.

The daemon carries out the answer. If no drive is running, it starts one again on the host the run used. What you write in your own words is passed to every later agent of the run as a decision to follow.

With nothing open, and no escalated run, the screen reads **Inbox zero**. It says so only while the daemon answers.

## Questions asked in the terminal

The heading **Needs you** counts runs, the same number as **need you** in the top bar; escalated runs are in it. When one run has two open questions the heading adds the number of rows (`· 3 items`).

An agent can also stop at a question it wrote on its own screen, without a card. Such a run still counts in **need you**. The Inbox lists it under the queue as a row marked `TERMINAL`, with the task and **answers in its terminal**. A click opens the run's **Session** screen on the pane that asks. Attach and type the answer there ([Sessions and worktrees](./sessions.md)).

## Permission prompts of the host

Sometimes the AI host shows its own permission prompt in the terminal ("Allow ... to run?"). MetatorAI never types into that prompt. The daemon puts it in the inbox as a question with two choices: **Attach and answer in the pane**, which gives you the keyboard of that pane, and **Leave it**. When the prompt is gone from the screen, the inbox item closes.

## Escalated runs

A run that reaches a loop limit, or whose agent stays blocked, becomes `escalated`. It needs work from you and a yes or no is not enough. Escalated runs count in the heading **Needs you** and are listed in the queue as rows marked `ESCALATED`, with the task and the stage the run stopped at. In the runs panel a click on an escalated run opens the same card.

The card shows why the run stopped (the failure its last stage recorded) and has four buttons:

- **Resume** puts the run back at the stage it escalated from and drives it on. Remove the cause first. The run gets a fresh set of tries for that stage. If no drive can start, the card says why.
- **Close run…** asks for a reason and ends the run as aborted.
- **Briefing** shows what happened in the run, and **Changes** shows its change.

The same from the terminal:

```bash
metator run resume --run <id> --by alice --drive
metator run close --run <id> --aborted --reason "not worth fixing"
```

## Get notified

A new question raises a system notification from the app. To be told elsewhere, set `notify.command` ([Configuration](../reference/configuration.md#notifications)).

The option `supervisor.wipLimit` (default 4) sets how many runs may wait for you at once. Above it, new runs start with a warning.

## From a terminal

```bash
metator inbox                     # every open decision, in the same order as the app
metator run questions             # the open questions of one run
```

```bash
metator run answer q001 --choice Approve --by alice
metator run answer q002 --choice Reject --text "split step 3 into two" --by alice
```

`--choice` is the label of an option; upper and lower case do not matter, so `approve` is Approve. `--text` carries your own words: the reason with Reject, or the answer with Other. `--by` is your name, which goes into the run's log. Without it the name comes from `$METATOR_USER`, or else from `git config user.name`. `--run` takes a run id or the start of one, as long as only one run starts that way.

The run's drive carries out the answer. If no drive is running, `metator run continue <run>` starts it again. At a terminal `metator inbox` prints the queue as text, each question with the command that answers it.

### Answers that repeat

If you answer the same question the same way every time, make the answer a policy. This exists only as a command:

```bash
metator run answer q004 --choice Deny --by alice --always
```

The policy is stored in `metator/answer-policies.yml`, so the team reviews it like code. From then on such a question is answered when it is asked, and the log says the policy answered it.

A policy has limits:

- It can deny a tool. It cannot allow one.
- It cannot answer a decision that cannot be taken back, such as a push.
- It cannot answer with Other or Reject, because those need your own words.

```bash
metator policy list
metator policy rm <id>      # such questions ask a person again
```
