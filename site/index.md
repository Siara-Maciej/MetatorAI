---
sidebar: false
aside: false
editLink: false
lastUpdated: false
---

# MetatorAI

MetatorAI is a workflow for AI coding agents. It works with GitHub Copilot and Claude Code and gives every task the same path: read the code, plan, write tests, build, check, review, and push after you approve.

The agent still writes the code. MetatorAI decides what the agent is allowed to take on trust:

| Job | Who does it | Example |
|---|---|---|
| Decide | the model | understand the task, write the plan and the code, find problems in a diff |
| Measure | the `metator` command | which tests a change reaches, which rules apply to a file, whether a plan is valid |
| Enforce | hooks your AI host runs | no edit outside the plan, no push before approval, no reading of secrets |
| Approve | you | the plan, the push, the review comments |

A step is finished when its result passes a check, not when the model says so.

## Try it

MetatorAI runs from a checkout and needs [Bun](https://bun.sh). Your own project can use npm, pnpm, Yarn or Bun.

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai && bun install && (cd packages/cli && bun link)

cd ~/code/your-repo
metator setup     # reads the repository, installs rules, generates agents and hooks
metator serve     # the local daemon the desktop app talks to
```

Then open the desktop app, click **+ New session** and describe the task. The app shows the agents at work, and the questions that wait for you arrive in its **Inbox**.

![The Inbox of the desktop app with a gate's decision card](./public/screens/inbox.png)

[Install](./guide/install.md) has the details, [First run](./guide/first-run.md) walks through one task, and [The app](./use/index.md) describes every screen.

Everything the app does is also a command: `metator run` starts a task in a terminal, and `metator inbox` lists what waits for you. See the [command reference](./reference/commands.md).

## Documentation

- [Guide](./guide/index.md): what MetatorAI is, how to install it, how a run works.
- [Use](./use/index.md): the app, starting a task, answering its questions, reading the change, your settings.
- [Repository](./repo/index.md): rules, agents, gates and hooks for your own repository.
- [Reference](./reference/index.md): commands, configuration, file formats, troubleshooting.
