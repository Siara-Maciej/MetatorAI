# Package architecture

`metator arch` reads the imports between the packages of a monorepo and reports what is wrong with the structure: cycles, undeclared dependencies, a library that imports an application. You can then write down the structure you intend, fail CI on new violations only, and plan a refactor with evidence. You do not need this in a repository with one package.

It works in any workspace that npm, yarn, pnpm, bun, lerna or rush understands.

## Analyze

```bash
metator arch analyze
```

This builds the package graph from the file import graph and writes three files under `.metator/arch/`: `report.json` for tools, `report.md` for reading, and `report.html`, a self-contained page with the same content.

The summary has a score: 100 minus 5 per error and 1 per warning. Use it to follow a trend over time.

Each file resolves through its nearest `tsconfig.json`. If dependencies are not installed and a tsconfig extends a package, MetatorAI warns that the graph is approximate. Install dependencies for the exact graph.

Two narrower views:

```bash
metator arch cycles     # the cycles, with the imports that close each
metator arch declared   # the package.json findings
```

## Violations

| Kind | Default | Meaning |
|---|---|---|
| `cycle` | error | packages depend on each other. A cycle closed only by `import type` is a warning. Test-only imports never make a cycle |
| `undeclared` | error | a file imports a package that its `package.json` does not declare |
| `root-only` | warning | only the repository root declares the dependency, so it works through hoisting |
| `dev-in-prod` | error | production code imports something declared only in `devDependencies` |
| `relative-import` | error | `../../other-package/src/x` instead of the package name |
| `app-import` | error | a package depends on an application |
| `unused-dependency` | warning | declared in `dependencies`, imported by no file and used in no script |
| `version-drift` | warning | one dependency declared with several version ranges across packages |
| `layer`, `unlayered`, `tag` | error, warning, error | your policy's layers and tag rules |
| `expired-exception`, `unused-exception` | error, warning | your policy's exceptions |
| `module-cycle`, `module-internal` | error | modules inside a package (see below) |

The report also describes each package without judging it: how many packages depend on it and it depends on, candidates to split or merge, exports nothing imports, package pairs that git history changes together, imports across owners, and the packages each application pulls in. Read these as signals. To turn one into a warning, set `thresholds` in the policy.

## Write a policy

Without a policy you get the checks above. A policy adds the structure you intend. Start from a proposal:

```bash
metator arch init
```

It writes `metator/architecture.yml` and never overwrites one. The proposal puts applications in a layer above every library and takes over the boundaries your tools already enforce (Turborepo and Nx). Then edit it:

```yaml
kind: ArchitecturePolicy
schemaVersion: 2
layers:                     # top to bottom; depending on a layer above is an error
  - name: apps
    packages: [apps/*]
  - name: features
    tags: [type:feature]
  - name: shared
    packages: ["@shop/money", "@shop/ui-*"]
packages:                   # kind, tags and layer by package name or directory glob
  - packages: ["@shop/cart", "@shop/checkout"]
    tags: [type:feature, scope:shop]
rules:                      # tag rules
  - from: scope:shop
    allow: [scope:shop, scope:shared]
  - from: type:ui
    deny: [type:data-access]
thresholds:
  fanOut: 8
severity:
  version-drift: off
exceptions:
  - violation: "layer:@shop/money→@shop/cart"   # an id from the report; * matches any text
    reason: "price rules move to @shop/pricing"
    owner: "@shop-platform"
    expires: 2027-03-31
```

| Key | Meaning |
|---|---|
| `layers` | ordered top to bottom. A package may depend on its own layer and the layers below |
| `packages` | assigns `kind` (`app` or `lib`), `tags` and `layer` to packages |
| `rules` | `from` a tag: what it may (`allow`) or may not (`deny`) depend on. `to` a tag: who may depend on it |
| `thresholds` | `fanOut`, `fanIn`, `files`, `depth`, `distance`: a package over the limit gets a warning |
| `severity` | change a kind's severity, or turn it `off` |
| `exceptions` | accept one violation until `expires`. An expired exception is an error, and one that matches nothing is a warning |
| `tests`, `ignore` | globs: which files count as tests, and which files to leave out |
| `modules` | folders to analyze as modules inside a package |

`metator arch schema` prints the JSON Schema of the file.

## Modules inside a package

In a modular monolith, one package holds its modules in folders. Name the folders and each module is analyzed like a package:

```yaml
modules:
  globs: ["src/module/*"]        # each folder is a module
  public: ["contracts/**"]       # what other modules may import; without it, every file
```

The report gets a Modules section. A cycle between modules is a `module-cycle` violation. An import of another module's file outside its public part is a `module-internal` violation.

## Fail only on what a change adds

A monorepo with history has violations today. `arch check` fails only for violations the change adds:

```bash
metator arch check --base main                      # new against the merge base with main
metator arch check --base main --strict             # new warnings fail too
metator arch check --base main --sarif arch.sarif   # also write a SARIF 2.1.0 log
```

A violation is not new when the merge base already has it, the baseline accepted it, or a policy exception covers it. Accept the current state once and commit the file:

```bash
metator arch baseline             # writes metator/arch-baseline.json
metator arch baseline --tighten   # drop entries that were fixed; never accepts new ones
```

Add the check to the full gate. The gate passes its `--base`:

```yaml
gates:
  full:
    - id: packages
      run: { metator: arch check }
```

The [GitHub action](./gates-ci.md#the-github-action) runs this check and can upload the SARIF log to code scanning.

## Try a move before you make it

`arch simulate` computes what a refactor would fix and break. It touches no file.

```bash
metator arch simulate move packages/pricing/src/rules.ts --to @shop/cart
metator arch simulate merge @shop/pricing --into @shop/cart
metator arch simulate extract "packages/kit/src/charts/**" --name @shop/charts --dir packages/charts
metator arch simulate invert @shop/pricing @shop/cart     # pricing keeps a port, cart implements it
```

The answer compares the summary before and after and lists the violation ids the move fixes (`fixed`) and adds (`added`), the number of import statements to rewrite (`rewrites`) and the dependencies the moved code needs declared in its new home (`declared`).

## Plan a refactor

A refactor plan is a file of moves, each with its reason. Moves in the same wave can run in parallel. A wave starts when the one before it is done.

```bash
metator arch plan propose "Break the pricing cycle" --goal no-cycles
```

This writes a fresh report and a draft in `metator/arch/plans/`. The `mt-arch-planner` agent then runs on your AI host (`--host claude` or `--host copilot`), tries moves with `arch simulate` and writes them into the plan with reasons and citations. MetatorAI adds each move's simulated effect and lints the plan.

```yaml
kind: RefactorPlan
schemaVersion: 1
id: break-the-pricing-cycle
title: Break the pricing cycle
goal: no-cycles
status: draft
moves:
  - id: rules-to-cart
    move: { type: move, files: [packages/pricing/src/rules.ts], to: "@shop/cart" }
    why: The rules read the cart, so they are cart behavior.
    citations: ["packages/pricing/src/rules.ts:1"]
    wave: 1
```

To write a plan by hand, start with `metator arch plan new <title>` and add moves. Then:

```bash
metator arch plan simulate break-the-pricing-cycle   # write each move's effect into the plan
metator arch plan lint break-the-pricing-cycle
```

Lint refuses a plan when a move cannot run (unknown package, files that match nothing), two moves of one wave move the same file, a citation does not exist, an effect is out of date, the plan adds an error or misses its goal, or the moves changed after approval.

## Approve and run the plan

```bash
metator arch plan approve break-the-pricing-cycle   # you, never an agent
metator arch plan run break-the-pricing-cycle       # start the next wave
metator arch plan status break-the-pricing-cycle    # read the runs back into the plan
```

- The approval covers the moves as they are. If you edit a move afterwards, approve again. The [hooks](./hooks.md) deny an agent that tries to approve.
- `run` starts each move of the next wave as an `mt-refactor` run in its own worktree (see [Refactor](../use/refactor.md)). Drive those runs as usual.
- `status` marks a move done when its run is done and blocked when its run was aborted or escalated. A blocked move stops its wave. Finish it by hand, then set the move's `status` in the plan to `pending` to run it again or to `done`.

## Measure the planner

`docs/metator/evals/arch/` holds small monorepos with a known problem. Run them when you change the planner's prompt or model:

```bash
metator arch eval list
metator arch eval run --host claude --min 0.8
```

Each case runs in a fresh repository. `--min` fails the command below that mean score.
