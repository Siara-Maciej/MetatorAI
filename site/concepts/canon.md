# Canon

The canon is your repository's knowledge in a form agents can load per file and tools can check: rules with an id and an enforcement level, patterns with an exemplar to copy, module cards, ADRs, lessons, and a memory map that says who reads what and how big it may be. It is committed and reviewed like code.

## Why it exists

Conventions in a wiki are not read at the moment an agent writes code. The canon is delivered to the agent for exactly the files it touches (`rules pack`), and the part of it a tool can decide (E1) fails CI when broken. New code starts from how your codebase already solves the problem (`similar`), not from the internet's average.

## Where it lives

| Canon | Where | What it holds |
|---|---|---|
| Rules | `docs/metator/rules/*.yml` | conventions with an id (`SHOP-CODE-001`), scope, examples and how they are enforced |
| Patterns | `docs/metator/patterns/*.yml` | how your code solves recurring problems, with an exemplar `file:line` |
| Module cards | `docs/metator/modules/*.card.md` | per package: a generated block from the graph plus curated responsibility, invariants and pitfalls |
| ADRs | `docs/adr/*.md` | decisions; agents draft them as `Proposed`, only people accept them |
| Memory map | `docs/metator/memory-map.yml` | every knowledge file, who reads and writes it, size budgets |
| Lessons | `docs/metator/lessons/*.md` | what runs taught, each with a citation |
| Claims | `docs/metator/claims.json` | statements from docs verified against the code |
| Agents and skills | `metator/agents/*.md`, `metator/skills/*/SKILL.md` | the canonical definitions the host files are generated from |

## Enforcement levels

| Level | Who decides | Effect |
|---|---|---|
| **E1** | a tool: ast-grep, Biome, tsc or a conformance test | fails CI; appears in `rules check` |
| **E2** | review lenses, from the rule pack for the files in scope | a finding with the rule id |
| **E3** | guidance only | in the rule pack, never a blocker |

`rules coverage --min-e1 <n>` keeps the E1 share from falling; `rules scaffold <id>` turns an E2 rule into an E1 rule with a failing test.

## Commands

```bash
metator rules pack --paths src/billing/invoice.ts   # only the rules that apply, sized for an agent
metator rules check --base main                     # E1 rules, mapped to rule ids
metator similar --file src/orders/customers.queries.ts   # the exemplar to follow, never legacy
metator cards build --check                         # module cards: generated block fresh
metator memory check                                # every knowledge file mapped, budgets kept, citations true
metator memory validate --fix                       # [[cite: file:line | "quote"]] follows moved code
```

## What enforces it

- `metator meta check-all` in CI: `rules lint`, `rules coverage`, generated instructions up to date, `memory check`, `cards build --check`, `docs links`, `docs drift`, `adr lint`.
- `plan lint` rejects a step that creates a file without an exemplar from the pattern index or an ADR.
- `guard post-edit` lints every file the moment it changes, with the E1 rules.
- A citation `[[cite: path:line | "quote"]]` is checked against the code; a quote that is gone marks the knowledge stale.

## One example

```bash
$ metator rules pack --paths packages/billing/src/invoice.ts
{"ok":true,"data":{"rules":[{"id":"MT-CODE-003","level":"E1","title":"A released schema version never changes", … }],
 "chars":2140}}
```

## Related

- [Write and enforce rules](../knowledge/rules.md), [Keep knowledge true](../knowledge/truth.md), [Agents and skills](../knowledge/agents.md).
- [Finding](./finding.md): how the canon shows up in a review.
