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

Status: pre-alpha. Commands and file formats can still change.

## Install

MetatorAI runs from a checkout and needs [Bun](https://bun.sh). Your own project can use npm, pnpm, Yarn or Bun.

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai && bun install && (cd packages/cli && bun link)   # puts `metator` on your PATH
```

## Use

```bash
cd ~/code/your-repo
metator setup                                  # reads the repository, installs rules, generates agents and hooks
metator run                                    # starts a task and shows it live
metator ui                                     # every session and every question that waits for you
metator ask "How is the discount computed?"    # an answer with file:line citations
```

In Copilot Chat or Claude Code you can also talk to the agents directly: `@mt-orchestrator` runs a task, `@mt-pr-review` reviews a change.

## What a run does

1. Survey. The agent reads the code with measured facts: the import graph, the rules that apply, similar code that already exists.
2. Plan. Every step names its file, the tests that come first and an example from your codebase. A script checks the plan and you approve it.
3. Build. Tests first, then the code, only in the files the plan names.
4. Check. Your gates run: lint, types, tests, architecture rules.
5. Review. Each finding quotes the code and shows how to trigger the problem. A second agent tries to refute it before you see it.
6. Ship. The push waits for your approval.

## Documentation

The full documentation is at **[siara-maciej.github.io/MetatorAI](https://siara-maciej.github.io/MetatorAI/)**.

| To | Read |
|---|---|
| Install and run a first task | [Install](https://siara-maciej.github.io/MetatorAI/guide/install), [First run](https://siara-maciej.github.io/MetatorAI/guide/first-run) |
| Understand runs, gates and approvals | [Runs and workflows](https://siara-maciej.github.io/MetatorAI/guide/runs), [Gates and approvals](https://siara-maciej.github.io/MetatorAI/guide/gates) |
| Do the daily work | [Use](https://siara-maciej.github.io/MetatorAI/use/) |
| Write rules a tool enforces | [Rules](https://siara-maciej.github.io/MetatorAI/repo/) |
| Put the gates into CI | [Gates and CI](https://siara-maciej.github.io/MetatorAI/repo/gates-ci) |
| Look up a command or an option | [Reference](https://siara-maciej.github.io/MetatorAI/reference/) |

## Contributing

```bash
bun install
bun run check        # lint, types, architecture rules, unit and end-to-end tests, mutation tests
bun run site:dev     # the documentation at http://localhost:5173/MetatorAI/
```

The code is a Bun monorepo built as ports and adapters: `core` holds the domain and use cases, plugins implement ports, `runtime` wires them, `cli` and `desktop` are the entry points. Instructions for working in this repository are in [`AGENTS.md`](AGENTS.md). Design documents (in Polish) are in [`docs/`](docs/README.md), decisions in [`docs/adr/`](docs/adr/README.md).
