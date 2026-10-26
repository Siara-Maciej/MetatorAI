# Write and enforce rules

**Goal:** your team's conventions become rules with an id, agents get exactly the rules that apply to the files they touch, and a tool fails CI when a rule is broken.

## 1. Write the rule in the canon

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

| Field | Why |
|---|---|
| `id` | review findings and gate failures cite it (`SHOP-CODE-001`) |
| `applyTo` | the rule reaches only agents working on matching files |
| `rationale`, `source` | where the rule comes from and when someone last checked it |
| `do`, `dont` | concrete examples; agents follow examples better than prose |

```bash
metator rules lint          # schema, ids, links, E1 implementations and their tests
```

## 2. See what an agent gets

```bash
metator rules pack --paths packages/billing/src/invoice.ts
```

```json
{"rules":[{"id":"SHOP-CODE-001","title":"No console.log in library code","enforcement":"E2",
  "summary":"Library code reports through return values, never by printing.", ...}],
 "enforcedByTools":[],"tokens":69}
```

**Why:** instead of a 30-page wiki, the agent gets only the rules for the files in scope, sized in tokens. `--budget <tokens>` caps the size; what did not fit is listed under `omitted`.

## 3. Generate host instructions

```bash
metator rules adapters      # .github/instructions/<area>.instructions.md with applyTo
```

Copilot loads these instruction files automatically for matching files. `rules adapters --check` in CI fails when they are stale.

## 4. Make the rule tool-enforced (E1)

```bash
metator rules scaffold SHOP-CODE-001
```

This writes an ast-grep rule and its test into the directories of your `sgconfig.yml`. The test fails until you fill in the real pattern and cases:

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

Then point the canon at it:

```yaml
    enforcement: E1
    implementation: ast-grep:shop-code-001
```

```bash
npx ast-grep test            # the rule's own tests
metator rules lint           # the E1 rule has an implementation and a test
```

## 5. Check the code

```bash
metator rules check                  # every file
metator rules check --base main      # only files changed on the branch
```

A violation names the canon rule, not only the tool rule:

```json
{"violations":[{"file":"packages/money/src/debug.ts","line":1,"column":26,
  "message":"SHOP-CODE-001: No console.log in library code",
  "engine":"ast-grep","toolRuleId":"shop-code-001","canonRuleId":"SHOP-CODE-001"}]}
```

Add `{ metator: rules check }` to your `quick` gate, and every edit an agent makes is checked immediately (the `guard post-edit` hook reports violations of the edited file back to the agent).

## Engines

| Engine | `implementation` | Good for |
|---|---|---|
| ast-grep | `ast-grep:<rule id>` | structural patterns: forbidden calls, imports, layering |
| Biome | `biome:lint/<group>/<rule>` | rules Biome already has; MetatorAI checks the rule is enabled |
| tsc | `tsc:<compiler option>` | compiler strictness (`tsc:noUncheckedIndexedAccess`) |
| test | `test:<rule id>` | anything a test can decide: `rules/conformance/<rule id>.test.ts`, with a `rejects ...` case |

## Track progress

```bash
metator rules coverage --min-e1 60    # fails below 60% tool-enforced rules
```

The report lists:

- E1 rules without a test;
- E1 rules whose tool rule is disabled;
- rules that never match a file;
- E2 rules without examples.
