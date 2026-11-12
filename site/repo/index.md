# Rules

A rule is a team convention with an id. Agents receive the rules that apply to the files they touch, and a rule a tool can decide fails the gate when it is broken. This page shows how to write one, deliver it and enforce it.

## Where repository knowledge lives

Rules are one part of what MetatorAI calls the canon: knowledge about your repository, committed and reviewed like code.

| What | Where | Holds |
|---|---|---|
| Rules | `docs/metator/rules/*.yml` | conventions with an id, a scope, examples and an enforcement level |
| Patterns | `docs/metator/patterns/*.yml` | how your code solves a recurring problem, with an exemplar file |
| Module cards | `docs/metator/modules/*.card.md` | one card per package: dependencies, owners, invariants, pitfalls |
| Decisions | `docs/adr/*.md` | decision records; agents draft them as `Proposed`, a person accepts them |
| Memory map | `docs/metator/memory-map.yml` | every knowledge file, who reads it and its size budget |
| Lessons | `docs/metator/lessons/*.md` | what earlier runs taught, each with a citation |
| Agents and skills | `metator/agents/*.md`, `metator/skills/*/SKILL.md` | the definitions the host files are generated from |

Cards, the memory map and lessons are on [Keep knowledge true](./knowledge.md). Agents and skills are on [Agents and skills](./agents.md).

## Write a rule

Rules live in rule set files, one per area:

```yaml
# docs/metator/rules/code.yml
kind: RuleSet
schemaVersion: 1
area: CODE
description: Coding conventions of the shop.
rules:
  - id: SHOP-CODE-001
    title: No console.log in library code
    applyTo: ["packages/*/src/**"]
    enforcement: E2
    summary: Library code reports through return values, never by printing.
    rationale: docs/adr/0001-errors.md
    source: { ref: docs/adr/0001-errors.md, verified: 2026-10-26 }
    do:
      - "return err(new Error('bad input'))"
    dont:
      - "console.log('bad input')"
```

| Field | Purpose |
|---|---|
| `id` | review findings and gate failures cite it |
| `applyTo` | globs: the rule reaches only agents working on matching files |
| `enforcement` | `E1`, `E2` or `E3` (see below) |
| `rationale`, `source` | where the rule comes from and when someone last checked it |
| `do`, `dont` | short examples of the right and the wrong form |

Check the file:

```bash
metator rules lint
```

It validates the schema, ids, links, and that every E1 rule has an implementation and a test. `metator rules schema` prints the JSON Schema of a rule set, and `metator rules show SHOP-CODE-001` prints one rule in full.

## Enforcement levels

| Level | Who decides | Effect |
|---|---|---|
| `E1` | a tool: ast-grep, Biome, tsc or a conformance test | a violation in `metator rules check`, which fails the gate |
| `E2` | the review, from the rules for the files in the change | a finding that cites the rule id |
| `E3` | nobody | guidance in the agent's rule pack |

Start a rule at E2 and move it to E1 when you can express it for a tool.

## See what an agent gets

```bash
metator rules pack --files packages/core/src/domain/hook.ts
```

In MetatorAI's own repository this prints (trimmed):

```json
{"ok":true,"data":{"paths":["packages/core/src/domain/hook.ts"],"rules":[],
 "enforcedByTools":[
  {"id":"MT-ARCH-001","title":"Domain code is pure","implementation":"ast-grep:mt-arch-domain-pure"},
  {"id":"MT-CODE-001","title":"Errors are values","implementation":"ast-grep:mt-code-001"}]}}
```

`rules` holds the E2 and E3 rules in full, because the agent has to follow them by reading. `enforcedByTools` lists the E1 rules by title only: the tool reports those. Without `--files`, the pack covers the files changed against `--base` (default `HEAD`). `--budget <tokens>` caps the size of the pack.

## Generate host instructions

```bash
metator rules adapters
```

This writes instruction files under `.github/instructions/` from the rules, each scoped by the rules' `applyTo`. Copilot loads them for matching files. Do not edit them by hand. `metator rules adapters --check` fails when they are out of date.

## Make a rule tool-enforced

```bash
metator rules scaffold SHOP-CODE-001
```

This writes an ast-grep rule and its test into the rule directories of your `sgconfig.yml`. The test fails until you fill in the pattern and the cases:

```yaml
# rules/ast-grep/shop-code-001.yml
id: shop-code-001
language: TypeScript
severity: error
message: "SHOP-CODE-001: No console.log in library code"
files:
  - packages/*/src/**
rule:
  pattern: console.log($$$ARGS)
```

```yaml
# rules/ast-grep-tests/shop-code-001-test.yml
id: shop-code-001
valid:
  - "return err(new Error('bad input'));"
invalid:
  - "console.log('bad input');"
```

Run the rule's own tests:

::: code-group

```bash [npm]
npx ast-grep test
```

```bash [pnpm]
pnpm exec ast-grep test
```

```bash [yarn]
yarn ast-grep test
```

```bash [bun]
bunx ast-grep test
```

:::

Then point the rule at its implementation and lint again:

```yaml
    enforcement: E1
    implementation: ast-grep:shop-code-001
```

The `implementation` names the engine and the tool's rule:

| Engine | `implementation` | Use it for |
|---|---|---|
| ast-grep | `ast-grep:<rule id>` | structural patterns: forbidden calls, imports, layering |
| Biome | `biome:lint/<group>/<rule>` | a rule Biome already has; MetatorAI checks that it is enabled |
| tsc | `tsc:<compiler option>` | compiler strictness, for example `tsc:noUncheckedIndexedAccess` |
| test | `test:<rule id>` | anything a test can decide: `rules/conformance/<rule id>.test.ts`, with at least one `rejects ...` case |

## Check the code

```bash
metator rules check                  # the whole repository
metator rules check --base main      # only files changed against main
metator rules check --files src/a.ts # only these files
```

Each violation carries the file, line and message, the tool's rule id (`toolRuleId`) and the rule's id (`canonRuleId`).

Add the check to your `quick` gate so that every change is checked before review (see [Gates and CI](./gates-ci.md)):

```yaml
gates:
  quick:
    - id: rules
      run: { metator: rules check }
```

With the [hooks](./hooks.md) installed, the agent also gets the violations of a file right after it edits it.

## Keep the share of enforced rules up

```bash
metator rules coverage --min-e1 60
```

The report counts active rules per area and level, and fails when fewer than 60 percent are E1. It also lists E1 rules without a test, E1 rules whose tool rule is disabled, rules that match no file, and E2 rules without examples.

## Point agents at existing code

A pattern file in `docs/metator/patterns/` names a recurring solution and the file that shows it best. Before an agent writes a new file, it asks how the repository already does it:

```bash
metator similar --file packages/core/src/application/invoices.ts
```

The answer is a ranked list of patterns with the exemplar file and line for each, and the reasons for the match. `metator patterns scan` finds every occurrence of every pattern and writes the pattern index.
