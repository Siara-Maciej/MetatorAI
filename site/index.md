---
sidebar: false
aside: false
editLink: false
lastUpdated: false
pageClass: mx-home
---

# MetatorAI

MetatorAI is a desktop app for working with AI coding agents on Claude Code or GitHub Copilot CLI. You talk to an agent in a chat. It answers from your code, makes a small change on the spot, or carries a larger one through a workflow with a plan, tests, gates and a review, in terminals you can watch. It stops where the decision is yours: the plan, a commit, a push, a comment on a pull request.

Everything runs on your machine, in your repositories.

![Terminals by task: the chat where the task was given on the left, the run's conductor working in its own Claude Code terminal on the right](./public/screens/real/real-06-task-view.webp)
*A task's terminals: the chat stays the main terminal, the run's conductor works beside it.*

## Two ways in

- **[Start with one repository](./guide/first-run.md)**: set the repository up, start the daemon, open the app and give the agent your first task.
- **[Start with many repositories](./guide/many.md)**: a folder that holds several repositories, one daemon and one app for all of them, and changes that cross applications.

[Install](./guide/install.md) comes first in both.

## How it works

### 1. Talk to the agent

Click **+ New chat** and say what you want. For each request the agent suggests the lightest way that fits, and you decide:

| Way | For | What happens |
|---|---|---|
| Direct | questions, and edits not meant for a commit | an answer with `file:line`, or an edit recorded so it can be taken out again |
| Quick | a small change meant to stay | build, the quick gate, one short review; it ends with a diff you look at |
| Full | everything else | a workflow: plan, your approval, tests and code, gates, review, your approval of the delivery |

![The chat answers how GET /prices/{sku} computes the price, citing src/server.ts and src/catalog.ts line by line, and says nothing changed](./public/screens/real/real-02-chat-answer.webp)
*A question answered in the chat with file:line; nothing changes and nothing starts.*

![The chat answers a small change with: This is too small for the full workflow: do it as quick?, naming the two files it would touch](./public/screens/real/real-04-quick-proposal.webp)
*The chat checks the change and suggests quick; you decide.*

### 2. Watch the agents, or do something else

Every agent works in a real terminal. **Terminals** shows a task's terminals side by side: you can read along, take the keyboard, or open a shell. You do not have to watch: the app tells you when something needs you.

![A run's session: the conductor, the planner that finished with its summary, and the implementer working, each in its own terminal](./public/screens/real/real-06-session-build.webp)
*A run's session: the conductor and its workers, each in its own terminal.*

### 3. Decide when it asks

**Home** shows every decision that waits for you, one at a time: the question or the plan, and its answers, with a recommended one. A commit or a push runs only on your word in the chat or your **Yes** on its card.

![Home: Approve the plan for Add GET /prices, with Approve, a field for changes and Ask for changes above the plan's five steps](./public/screens/real/real-06-plan-card.webp)
*A plan-approval card: the whole plan, Approve and Ask for changes.*

![Home: Claude Code asks to run git add and git commit; the card says git commit needs your consent, with Yes, No, Attach and answer in the pane, and Leave it](./public/screens/real/real-05-permission-card.webp)
*A commit the agent asks for comes to Home as a card; it runs only on your Yes.*

### 4. Read the change

**Changes** shows a run's diff. Write a note on a line and send it to the agent, the way you would review a colleague.

![The change of a run: the changed files on the left, the diff on the right, and a note under one line](./public/screens/changes.png)

### 5. Reviews of pull requests

Paste a pull request's link in a chat and the agent reviews it; nothing is published before your **Yes**. **Reviews** watches it for new commits. When someone reviews your own pull request, the agent drafts the replies and plans the fixes, and sends nothing until you choose.

![Reviews: a watched pull request with its findings and their states](./public/screens/reviews.png)

## Everything is also a command

The app is a window over the `metator` command, which agents and CI call too. `metator quick start` and `metator run` start work, `metator inbox` lists what waits for you, and `metator status` shows every run. See the [command reference](./reference/commands.md).

## Documentation

- [Start](./guide/index.md): what MetatorAI is, how to install it, and the two ways in.
- [Work](./use/index.md): the app day to day: chats, quick and full runs, Home, terminals, reviews.
- [Many repositories](./many/index.md): a folder of repositories, systems of applications, system plans.
- [Your repository](./repo/index.md): rules, agents, hooks, gates and intake for your own repository.
- [Reference](./reference/index.md): commands, configuration, the daemon's HTTP API, file formats, troubleshooting.
