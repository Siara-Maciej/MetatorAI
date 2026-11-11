# What MetatorAI is

MetatorAI is a workflow layer around GitHub Copilot and Claude Code. Your AI tool still writes the code. MetatorAI gives the work a fixed sequence of stages, checks each stage with a command, and stops where a person has to decide.

It does not replace your AI tool, your linter or your tests. It runs them.

You work in the MetatorAI desktop app: you describe a task there, answer the questions a run has for you, watch the agents in their terminals and read the change. The `metator` command is what the app, the agents and CI call. Everything the app does can also be done from a terminal with that command.

## Who does what

The work is split four ways, and each part is done by whoever can be held to it.

| Part | Done by | Examples |
|---|---|---|
| Decide | the model | understand the task, write the plan, write the code, find problems in a diff |
| Measure | the `metator` CLI | which files and tests a change reaches, which rules apply to a file, whether a plan is complete |
| Enforce | hooks that the AI tool runs | no push without approval, no reading `.env`, a lint after every edit |
| Approve | you | the plan, the push, comments on a pull request |

A rule written in a prompt holds only while the model remembers it. A rule checked by a command or a hook holds every time, so MetatorAI moves as many rules as it can out of the prompt.

## What a run looks like

A run is one task carried through a workflow. This is the shipped feature workflow, `mt-feature`:

1. Survey. Agents read measured facts about the code the task touches: the import graph, existing patterns, and the rules for those files.
2. Plan. A planner writes steps. Each step names a file, the tests to write first, and an existing file to model the new code on.
3. Plan check. `metator plan lint` checks the plan, then a second agent criticises it.
4. Plan approval. The run stops until you approve the plan or send it back.
5. Build. Agents write the tests, then the code. Hooks lint each file as it changes.
6. Gates. The run executes your own `lint`, `typecheck` and `test` scripts. A failure goes back to the build stage a limited number of times.
7. Review. Review agents look for problems, a verifier tries to refute each one, and a judge decides.
8. Delivery. The run stops again. Nothing is pushed until you approve.

Each stage leaves a file in the run's directory (`plan.json`, `gates.md`, `verdict.json`), and every transition is written to a log. You can close the chat and continue the run later, from the same tool or another one.

## What it adds to your repository

`metator setup` writes these, and you commit them:

| Path | What |
|---|---|
| `metator.config.yml` | which AI tools you use and which of your scripts are the quality gates |
| `metator/` | the agents and skills, in one format for every AI tool |
| `.github/metator/workflows/` | the workflow specs |
| `.claude/`, `.github/agents/`, `.github/skills/`, `.github/hooks/` | the files generated for Claude Code and Copilot |

Run state goes to `.metator/`, which setup adds to `.gitignore`.

## Where to go next

- [Install](./install.md) the `metator` command.
- [First run](./first-run.md): set up a repository and take one task through the app.
- [The app](../use/index.md): its screens, and how to start it.
