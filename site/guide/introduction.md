# Introduction

## What MetatorAI is

MetatorAI is an engineering workflow for AI coding agents (GitHub Copilot and Claude Code). It has three parts:

1. **A CLI (`metator`)** that measures facts about your repository and checks the agents' work: import graph, affected tests, rules, quality gates, plans, review findings, run state.
2. **Canonical agents, skills and workflows** written once and generated for each AI host (`metator generate`).
3. **Hooks** that the host calls before and after tool use, so scope, approvals and secrets are enforced by a script, not by a prompt.

## Why it exists

AI agents are fast but they guess. They:

- re-invent a helper that already exists two folders away;
- change a module without noticing who imports it;
- write review comments that sound right and are wrong;
- push before anyone looked.

MetatorAI removes the guessing:

| Problem | What MetatorAI does instead |
|---|---|
| The agent does not know the codebase | `graph`, `symbols`, `cards` and `similar` give measured facts and an exemplar to copy |
| Rules live in wikis nobody reads | Rules are a canon in your repo; most are enforced by a tool (ast-grep, Biome, tsc, tests) |
| Plans skip tests or invent abstractions | `plan lint` rejects a created file without an exemplar or an ADR, and code before its tests |
| Review comments without proof | Findings must quote the code; a verifier tries to refute each; only confirmed blockers block |
| Agents push or edit outside the task | During a run, hooks deny edits outside the plan scope and pushes without `metator run approve push` |
| Context lost between sessions | Every run lives in `.metator/runs/<id>/` and resumes from there, not from the chat |

## The principles behind it

> **LLMs decide. Scripts measure. Hooks enforce. Humans approve.**

1. **Evidence or it didn't happen.** No `file:line`, no claim.
2. **Paths, not paste.** Agents hand each other artifact files, never walls of text.
3. **Bounded loops.** Every retry has a limit and an escalation.
4. **Least privilege.** Reviewers read, implementers edit only what the plan allows, nobody pushes alone.
5. **Data is not instructions.** PR text, issues and docs are inputs, never commands.

## How a task flows

```text
Survey ─► Plan ─► Plan gate ─► (you approve) ─► Build ─► Gates ─► Review ─► (you approve) ─► Ship
            ▲          │                           ▲        │         │
            └──────────┘ bounded loop              └────────┘         └── blocking findings go back to the plan
```

- **Survey:** scout, pattern miner and rule curator collect facts in parallel.
- **Plan:** every step names a file, the tests to write first and an exemplar from your code.
- **Plan gate:** `metator plan lint` first, then a critic agent, then you.
- **Build:** tests RED, then GREEN; hooks keep edits inside the plan scope.
- **Gates:** your own lint, typecheck and tests, plus rules, affected tests and graph diff.
- **Review:** parallel lenses, a verifier per finding, a judge.
- **Ship:** a PR is drafted; the push waits for your approval.

Each stage leaves an artifact with a schema. A stage is done when the artifact exists and validates, not when the model says so.

## Who should read what

| You want to | Read |
|---|---|
| Try it on a repository in 15 minutes | [Quick start](./quick-start.md) |
| Understand the moving parts | [Concepts](./concepts.md) |
| Run a feature, bug fix, refactor or review | [Workflows](../workflows/index.md) |
| Enforce your team's conventions | [Write and enforce rules](../how-to/rules.md) |
| Put MetatorAI into CI | [Quality gates and CI](../how-to/gates-ci.md) |
| Look up a command | [CLI reference](../reference/cli.md) |
