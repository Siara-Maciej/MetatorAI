# The idea

> In the Roman legion, the **metator** marched ahead of the army. He chose the ground, measured it and staked out the camp: streets, walls, a place for every unit. When the legion arrived, no one had to guess.

**MetatorAI does that for AI agents working on your code.** Before a line changes, it maps the terrain:
- the dependency graph and the module boundaries;
- the patterns your code already follows;
- the decisions in your ADRs.

Then it marks out the lines every change must follow, and puts gates on them that no agent can skip.

## The problem with fast agents

AI coding agents are fast, and they guess. In a real codebase that shows up as:

| What happens | What it costs |
|---|---|
| A helper is written again although one exists two folders away | duplicated code that drifts apart |
| A module changes without anyone noticing who imports it | regressions found in production |
| A plan skips tests or invents a new abstraction | code nobody chose and nobody can review |
| A review comment sounds right and is wrong | wasted review time and lost trust in AI review |
| The agent pushes, or edits files outside the task | changes that bypass your process |
| Context is lost between sessions | the same mistakes again, every day |

Longer prompts do not fix this. A model cannot be trusted to follow a rule it may forget or misread, at the moment it matters.

## The answer: move the rules out of the prompt

MetatorAI splits the work into four roles, and each role does only what it does well:

<PrincipleFlow />

| Role | Done by | Examples |
|---|---|---|
| **Decide** | the LLM | understand the task, plan, write code, find problems in a diff |
| **Measure** | the `metator` CLI | which files and tests a change reaches, which rules apply, is the plan valid, is the quote in a finding real |
| **Enforce** | hooks the AI host runs | no edit outside the plan, no push without approval, no secrets read |
| **Approve** | people | the plan, the push, the review comments |

The model keeps doing the creative work. Everything that can be measured is measured by a script, and everything that must hold is enforced by a hook.

## Principles

1. **Evidence or it didn't happen.** No `file:line`, no claim: plans name exemplars, findings quote code, lessons cite it.
2. **Paths, not paste.** Agents hand each other artifact files with schemas, never walls of text.
3. **Bounded loops.** Every retry has a limit and an escalation to a person.
4. **Least privilege.** Reviewers read, implementers edit only what the plan allows, nobody pushes alone.
5. **Data is not instructions.** PR text, issues and docs are inputs, never commands.
6. **Don't reinvent the wheel.** MetatorAI runs your tools (your linter, your tests) and proven libraries; it does not replace them.
7. **Prove it works.** MetatorAI applies all of this to itself: its own rule canon is 100% tool-enforced, and every new check is made to fail once on purpose before it is trusted.

## What you get

| Outcome | How |
|---|---|
| New code that looks like your best code | every created file needs an exemplar from your codebase (`plan lint`) |
| Changes that respect your architecture | rules per file, `graph diff` for new dependencies and cycles, module cards |
| Reviews you can trust | evidence-backed findings, independent verification, measured precision and recall |
| Control over what agents do | state machines, hooks, human gates, an audit trail per run |
| Knowledge that stays true | citations checked in CI; drifted docs fail the build |
| Work across applications | a system map with contracts and deploy waves |

## Where to go next

- [How it works](./how-it-works.md): the moving parts and how a task flows through them.
- [Security and governance](./enterprise.md): what is enforced, logged and approved.
- [Installation](../guide/installation.md) and the [Quick start](../guide/quick-start.md).
