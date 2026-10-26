---
layout: home

hero:
  name: MetatorAI
  text: Your agents are fast. MetatorAI makes them right.
  tagline: Survey the codebase, lay out the rules, prove every claim, then ship. An engineering workflow for GitHub Copilot and Claude Code.
  image:
    src: /logo.svg
    alt: MetatorAI
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: What is MetatorAI?
      link: /guide/introduction
    - theme: alt
      text: CLI reference
      link: /reference/cli

features:
  - icon: 🧭
    title: Measured facts, not guesses
    details: An import graph, module cards, owners and the rules for exactly the files in scope. Agents start from facts the CLI measured.
  - icon: 🚧
    title: Gates no agent can talk past
    details: Workflows are state machines. Scripts validate every stage, hooks block edits outside the plan and pushes without your approval.
  - icon: 🔍
    title: Review that proves itself
    details: Every finding quotes the code and names how it is reached. A verifier tries to refute it. Unproven findings never block.
  - icon: 🧠
    title: Memory that stays true
    details: Rules, lessons and docs cite file:line. CI re-checks every citation, so knowledge that drifted from the code is caught.
  - icon: ♻️
    title: Refactors that keep behavior
    details: Characterization tests, API snapshots and import-graph diffs turn "nothing changed" into something you can prove.
  - icon: 🎛️
    title: One canon, every host
    details: Agents, skills, rules and hooks are written once and generated for GitHub Copilot and Claude Code.
---

## How it works in one minute

```bash
metator init                                   # survey the repo, propose metator.config.yml with evidence
metator generate                               # Copilot and Claude Code agents from one canonical source
metator run init --workflow mt-feature --task "Add combined discount"
metator graph affected --base main             # which files and tests the change reaches
metator gate full                              # the repo's own checks, one report
metator run approve push --by alice            # nothing is pushed until a human says so
```

Then, in Copilot Chat or Claude Code, ask the `mt-orchestrator` agent to run the task. It moves the run stage by stage and calls the CLI for every fact it needs.

::: warning Pre-alpha
MetatorAI runs from a checkout of its repository and is not on npm yet. Commands and file formats can still change; every file carries a `schemaVersion` and is migrated on read.
:::
