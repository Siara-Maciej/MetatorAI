[![build](https://github.com/Siara-Maciej/MetatorAI/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Siara-Maciej/MetatorAI/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https://siara-maciej.github.io/MetatorAI/badges/tests.json)](https://siara-maciej.github.io/MetatorAI/repo/gates-ci#the-metatorai-readme-badges)
[![coverage](https://img.shields.io/endpoint?url=https://siara-maciej.github.io/MetatorAI/badges/coverage.json)](https://siara-maciej.github.io/MetatorAI/repo/gates-ci#the-metatorai-readme-badges)
[![mutants killed](https://img.shields.io/endpoint?url=https://siara-maciej.github.io/MetatorAI/badges/mutation.json)](https://siara-maciej.github.io/MetatorAI/repo/gates-ci#the-metatorai-readme-badges)
[![docs](https://img.shields.io/badge/docs-siara--maciej.github.io%2FMetatorAI-blue)](https://siara-maciej.github.io/MetatorAI/)
[![download](https://img.shields.io/badge/download-desktop%20app-2ea44f)](https://github.com/Siara-Maciej/MetatorAI/releases/tag/desktop-latest)

# MetatorAI

MetatorAI is a desktop app where you talk to AI coding agents on Claude Code or GitHub Copilot CLI, watch them work in real terminals, and decide yourself everything that matters: the plan, a commit, a push.

Everything runs on your machine, in your own repositories. The pictures below are the real app with real Claude Code sessions.

## What it does for you

### Talk to an agent about your code

Click **+ New chat** and ask, as you would ask a colleague. The agent reads your code and answers with the file and line it found the answer in. A question changes nothing and starts nothing.

![A chat in the app: Claude Code answers how a price is computed, citing src/server.ts and src/catalog.ts line by line](site/public/screens/real/real-02-chat-answer.webp)

### A quick fix or a full workflow: you decide

For each request the agent suggests the lightest way that fits, and asks. A small change meant to stay can be a **quick** change: it is made, your own checks run on it, one reviewer reads it, and you get the diff to look at. Anything bigger goes through a **full** workflow: a plan, your approval, tests and code, your checks, a review, and your approval before it ships. Whether a change is small enough is decided by a command, not by the model, and you can always pick the other way.

![The chat suggests a quick change: "This is too small for the full workflow: do it as quick?", with the two files it would touch](site/public/screens/real/real-04-quick-proposal.webp)

### Debug edits, removed in one click

Ask for a temporary `console.log` and the agent adds it at once, and records it. Home shows **Debug changes** until you are done; **Remove debug changes** takes the lines back out of your files and leaves the rest of your work alone. A commit that would take a debug line by accident is stopped.

![The Debug changes list: the file, what the edit was for and when, with Remove and Remove debug changes](site/public/screens/real/real-03-debug-changes-list.webp)

### Nothing is committed or pushed without your yes

A `git commit`, `push`, `merge` or `rebase` runs only when you say so: **Yes** on its card, your own words in the chat ("commit it"), or your approval of a finished run. Destructive commands such as `git push --force` or `git reset --hard` are refused outright. This holds for every agent, on Claude Code and on Copilot CLI.

![Home: Claude Code asks to run git commit; the card says it needs your consent, with Yes, No, Attach and answer in the pane, and Leave it](site/public/screens/real/real-05-permission-card.webp)

### Questions and approvals come to you as cards

You do not have to watch the agents. When one needs you (a plan to approve, a question, a permission prompt from Claude Code or Copilot, a quick change to look at), it comes to **Home** as a card, one at a time, with a recommended answer. Answer there and the agent goes on; a system notification tells you when something new waits.

![Home: "Quick change ready: look at the diff", with Open diff, Fine and Other, and 2 waiting](site/public/screens/real/real-04-quick-ready-card.webp)

### Watch every agent's real terminal, task by task

Every agent works in a real terminal of your AI tool. **Terminals** shows a task's terminals side by side: the run's conductor, the planner that finished, the implementer at work. Read along, take the keyboard, or type to an agent yourself. A finished terminal stays on screen with a line that says how it ended.

![Terminals: the conductor, the finished planner and the implementer working, each in its own Claude Code terminal](site/public/screens/real/real-06-session-build.webp)

### Plans you approve

A full run writes a plan before it touches the code: each step with its file, what changes and which test comes first. The run stops until you read it. **Approve** lets it build; **Ask for changes** sends your words back to the planner, which writes a new plan.

![Home: the plan to approve, five steps with their files and tests, Approve and Ask for changes above it](site/public/screens/real/real-06-plan-card.webp)

### A Backlog with analysis and plans on demand

Keep tasks for later in the **Backlog**. **Analyse** has an agent read the code for a task and write down what exists today, what the change touches and its risks. **Make plan** has the plan written and approved without building anything yet. A badge says whether the analysis and the plan still match the code. **Implement** starts the work from that plan when you are ready.

![The Backlog: a task with its fresh analysis and its plan ready, with Re-analyse, Make plan and Implement](site/public/screens/real/real-07-backlog-plan-ready.webp)

### One task across several repositories

Work from a folder that holds several repositories with one app and one Home. When a change crosses applications that call each other, MetatorAI makes it a system plan: one step per repository, in the order they must ship, each step a run in its own repository with a terminal you can watch.

![Terminals for a task over two repositories: the chat, and one session each for shop-api and shop-web](site/public/screens/real/real-09-system-task-tiles.webp)

### Works with Claude Code or GitHub Copilot CLI

MetatorAI does not replace your AI tool: it runs it. Setup finds the tool your repository already uses, or the one installed on your machine, and writes the agents, skills and safety hooks for Claude Code, Copilot CLI, or both.

![A new chat: Claude Code starts in the app's terminal, ready for the first question](site/public/screens/real/real-02-new-chat.webp)

## Get started

1. Download the desktop app for Windows, macOS or Linux from [Releases](https://github.com/Siara-Maciej/MetatorAI/releases/tag/desktop-latest). The `metator` command is inside it.
2. Open it and click **Add repository**: choose your project's folder, choose the AI host, **Set up**, and **Commit** the files setup wrote when you want them in your history.

That is all, plus git and Claude Code (`claude`) or GitHub Copilot CLI (`copilot`), installed and logged in. The app checks both and says how to install what is missing. Nothing comes from npm.

Prefer the terminal only, without a window? Download the `metator` command for your platform from the same Releases and use it with Claude Code or Copilot CLI: [Install, terminal only](https://siara-maciej.github.io/MetatorAI/guide/install?way=cli).

Is your repository in a dev container? **Add repository**, **Dev Container**: the app on Windows or macOS only shows the window, and everything else runs in the container ([Dev Containers](https://siara-maciej.github.io/MetatorAI/guide/devcontainers)).

The app starts the repository's daemon itself; click **+ New chat**. [Get the desktop app](https://siara-maciej.github.io/MetatorAI/guide/desktop-app) has the details, [Install](https://siara-maciej.github.io/MetatorAI/guide/install) puts `metator` in your terminal too, and [Start with one repository](https://siara-maciej.github.io/MetatorAI/guide/first-run) walks you through the first chat.

## Documentation

**[siara-maciej.github.io/MetatorAI](https://siara-maciej.github.io/MetatorAI/)**

- [Install](https://siara-maciej.github.io/MetatorAI/guide/install) and [Start with one repository](https://siara-maciej.github.io/MetatorAI/guide/first-run)
- [Start with many repositories](https://siara-maciej.github.io/MetatorAI/guide/many) and [System plans](https://siara-maciej.github.io/MetatorAI/many/plans)
- [The app](https://siara-maciej.github.io/MetatorAI/use/), [Chats and the three ways](https://siara-maciej.github.io/MetatorAI/use/start), [Home and the Board](https://siara-maciej.github.io/MetatorAI/use/inbox)
- [Approvals and consent](https://siara-maciej.github.io/MetatorAI/use/approvals)
- [Teach MetatorAI your repository](https://siara-maciej.github.io/MetatorAI/repo/)
- [Reference](https://siara-maciej.github.io/MetatorAI/reference/): commands, configuration, troubleshooting

Want to work on MetatorAI itself? Start with [`AGENTS.md`](AGENTS.md).
