# Package architecture

**What for:** in a monorepo with dozens of packages and several applications, structure decays quietly. Two libraries start to import each other, a package imports something it never declared, a shared library reaches into an application. `metator arch` turns the import graph into a **package graph** and tells you what is wrong with it, with the files that prove it.

Run it in the repository (or with `-C <repository>` from a folder of repositories). Any workspace that npm, yarn, pnpm, bun, lerna or rush understands works, installed or not.

## Analyze

```bash
metator arch analyze
```

```json
{"files":{"json":".metator/arch/report.json","markdown":".metator/arch/report.md"},
 "policy":null,
 "summary":{"packages":5,"apps":1,"edges":5,"cycles":1,"errors":5,"warnings":2,"excepted":0,"score":73},
 "packages":[{"name":"@shop/web","kind":"app","dependsOn":["@shop/cart"],"dependents":[]}, "…"],
 "cycles":[{"packages":["@shop/cart","@shop/pricing"],"typeOnly":true,"edges":["…"]}],
 "violations":[{"id":"app-import:@shop/banner→@shop/web","severity":"error",
                "message":"@shop/banner depends on the application @shop/web; applications sit on top and nothing imports them",
                "evidence":[{"file":"packages/banner/src/index.ts","to":"apps/web/src/index.ts"}]}, "…"]}
```

**What it does:**
1. Builds the file import graph (incremental, cached in `.metator/index`).
2. Gives every file to the deepest package that contains it. Files outside every package belong to `(root)`.
3. Adds up the imports between packages into edges: how many imports, how many of them are not `import type`, whether only tests import, and which `package.json` field declares the dependency.
4. Finds what is wrong (below) and writes `report.json` for tools and `report.md` for people.

Each file resolves through its nearest `tsconfig.json`, so an app's own `paths` (`@/*`) work. Before `install`, a tsconfig that extends a package (`@shop/typescript-config/nextjs.json`) cannot be loaded. MetatorAI then uses that tsconfig's own `paths` and warns that the result is approximate. Install dependencies for the exact graph.

The **score** is 100 minus 5 per error and 1 per warning. Use it as a trend, not as a grade.

## What it finds

| Kind | Default | Meaning |
|------|---------|---------|
| `cycle` | error | Packages depend on each other (test-only imports never make a cycle). A cycle closed only by `import type` is a warning. |
| `undeclared` | error | A file imports a package (workspace or npm) that its `package.json` does not declare. An import whose `@types/` package is declared counts as declared (`import { Request } from "express"` with `@types/express`: TypeScript drops it). Runtime modules are not packages: `node:*`, `bun:*`, `k6` in load tests. |
| `root-only` | warning | Only the repository root declares it, so it works through hoisting and breaks when the package is used alone. |
| `dev-in-prod` | error | Production code imports something declared only in `devDependencies`. Tests, tool configuration (`*.config.*`, `jest.setup.*`) and tool packages (a shared lint or TypeScript config that every package declares only in `devDependencies`) are not production code. |
| `relative-import` | error | `../../other-package/src/x` instead of the package name. |
| `app-import` | error | A package depends on an application. |
| `unused-dependency` | warning | Declared in `dependencies`, imported by no file (stylesheets count: `@import "tw-animate-css"`), not used in a script. |
| `version-drift` | warning | One dependency declared with several version ranges across packages. |
| `layer`, `unlayered`, `tag` | error, warning, error | Your policy's layers and tag rules (below). |
| `expired-exception`, `unused-exception` | error, warning | Your policy's exceptions. |
| `module-cycle` | error | [Modules inside a package](#modules-inside-a-package) depend on each other (a warning when only `import type` closes the cycle). |
| `module-internal` | error | A module imports another module's file outside its public part (`contracts/**`). |

Two narrower views:

```bash
metator arch cycles     # just the cycles, with the edges inside each
metator arch declared   # just the package.json findings
```

What the analyzer cannot resolve (dynamic paths, bundler aliases outside `tsconfig`) is counted under **Limits** in the report. Those imports are not in the graph.

## Read the structure

Besides violations, the report describes the packages. These are **signals for a person or an agent to judge**, not errors:

| Section | What it says |
|---------|--------------|
| **Metrics** per package | `Ca` (packages that depend on it), `Ce` (packages it depends on), instability `I = Ce/(Ca+Ce)`, abstractness `A` (share of exports that are types), distance from the main sequence `D = |A+I−1|`, depth (longest chain below it) and the share of its exports other packages import. |
| **Split?** | A library whose files form separate groups, tied together only by its barrel, each used by different packages. |
| **Merge?** | A private library with exactly one dependent. Not proposed for a family of three or more packages with the same dependent and dependencies (adapters of one port), or across layers or tags. |
| **Hubs** | Packages with at least 3 dependents and 3 dependencies. |
| **Dead exports and packages** | Exports nothing imports (tests count as users; an application's entry points and a published package's API do not count as dead), and private libraries nothing depends on. |
| **Changed together** | Package pairs that git history changes in the same commits (at least 3 times and half of the time), with whether one imports the other. Coupling without an import is a boundary in the wrong place. Commits that touch more than 10 packages are ignored. |
| **Teams** | Imports between packages of different owners (from `CODEOWNERS`) and packages without an owner. |
| **Applications** | Every package each application pulls in, and for each package the applications a change to it reaches (blast radius). |

Set `thresholds` in the policy to turn a metric into a warning, e.g. `fanOut: 8`, `files: 400`, `distance: 0.7`, `depth: 6`.

Open `.metator/arch/report.html` in a browser for the same report as a page. It has the package graph (applications on top, cycle edges red, broken rules orange) and works offline.

## Modules inside a package

A modular monolith is one package with its modules in folders: a NestJS app with `src/module/*`, a frontend organised by `features/*`. Name the folders in the policy and every module is analyzed like a package:

```yaml
# metator/architecture.yml
modules:
  globs: ["src/module/*"]        # each folder is a module
  public: ["contracts/**"]       # what other modules may import; without it, every file
```

`arch init` proposes this when it finds a `module`, `modules`, `features`, `domains` or `contexts` folder with three or more modules, and `public: [contracts/**]` when the modules already keep a `contracts/` folder.

The report then has a **Modules** section:
- each module with its files, what it depends on and what depends on it;
- the pairs that import each other;
- the cycles;
- a `module-cycle` violation for each cycle, and a `module-internal` violation for each pair that imports past the public part, with the files.

Test files do not count. Folders with one name in different packages are named by package and folder (`web/Auth`).

```text
17 modules in src/module/*; public part: contracts/**.
Import each other (12): auth ⇄ users, buyer ⇄ financing, cars ⇄ organizations, …
- Cycle of 9: auth, cars, companies, locations, offers, organizations, permissions, roles, users
- Cycle of 4: buyer, financing, integrations, sse-notifications
```

Accept what is there with `arch baseline`. From then on, `arch check` fails a change only for a new boundary it breaks (`module-internal:mail→users`), like for packages.

## Try a move before you make it

Every cycle in the report comes with its **cheapest cut**: the edges whose removal leaves no cycle, with the fewest imports to move. The cut is exact for cycles of up to seven packages and comes from an ordering heuristic above that.

To see what a refactor would do before anyone edits code, simulate it:

```bash
metator arch simulate move packages/pricing/src/rules.ts --to @shop/cart      # files or globs to another package
metator arch simulate merge @shop/pricing --into @shop/cart                   # one package into another
metator arch simulate extract "packages/kit/src/charts/**" --name @shop/charts --dir packages/charts
metator arch simulate invert @shop/pricing @shop/cart                          # pricing keeps a port, cart implements it
```

```json
{"moves":[{"type":"invert","from":"@shop/pricing","to":"@shop/cart"}],
 "effect":{"before":{"cycles":1,"errors":5,"warnings":2,"score":73},"after":{"cycles":0,"errors":5,"warnings":1,"score":74},
           "fixed":["cycle:@shop/cart,@shop/pricing"],
           "added":[],
           "rewrites":1,"declared":[]},
 "cycles":[]}
```

- `fixed` and `added` are violation ids before and after the move.
- `rewrites` counts the import statements that change package (what a codemod rewrites).
- `declared` lists the dependencies the moved code needs in its new home. Declarations that were already missing move with the files and stay visible; a declaration the move makes unused (pricing no longer imports cart) is dropped.

Nothing is written, and the simulation runs the same analysis as `arch analyze`, so a proposal by a person or an agent is judged by numbers, not by opinion.

## Plan the refactor

A refactor plan is a file of moves, each with the reason it exists. Moves of one wave run in parallel, and a wave starts when the one before it is done. Let the planner write one:

```bash
metator arch plan propose "Break the pricing cycle" --goal no-cycles     # --host claude|copilot
```

1. MetatorAI writes a fresh report and an empty draft `metator/arch/plans/break-the-pricing-cycle.yml`.
2. `mt-arch-planner` runs on your AI host. It reads the report, the module cards and the code, tries each move with `arch simulate`, and writes the moves with their reasons and citations.
3. MetatorAI writes each move's effect into the plan (`arch plan simulate`) and lints it. The plan stays a draft: an approval the planner writes itself is dropped.

```yaml
kind: RefactorPlan
schemaVersion: 1
id: break-the-pricing-cycle
title: Break the pricing cycle
goal: no-cycles                      # or no-errors, fewer-violations
status: draft
moves:
  - id: rules-to-cart
    move: { type: move, files: [packages/pricing/src/rules.ts], to: "@shop/cart" }
    why: The rules read the cart; they are cart behavior, so pricing no longer needs cart.
    citations: ["packages/pricing/src/rules.ts:1", "docs/metator/modules/shop-cart.card.md"]
    wave: 1
    effect:                          # written by `arch plan simulate`, never by hand
      scoreBefore: 95
      scoreAfter: 100
      fixed: ["cycle:@shop/cart,@shop/pricing"]
      added: []
      rewrites: 1
      declared: []
result:
  before: { cycles: 1, errors: 1, warnings: 0, score: 95 }
  after: { cycles: 0, errors: 0, warnings: 0, score: 100 }
```

You can also write a plan by hand: `metator arch plan new <title> --goal …`, then add moves (`metator arch plan schema` prints the format).

**Lint** (`metator arch plan lint <id>`) refuses a plan when:
- a move cannot run where it stands (unknown package, files that match nothing). Moves of one wave run in parallel in separate worktrees, so each must be possible on the state the earlier waves leave, not on what a sibling in its wave creates;
- two moves of one wave move the same file;
- a citation does not exist;
- an effect is out of date;
- the plan adds an error, or does not reach its goal;
- the moves changed after the approval.

A move that fixes nothing on its own is a warning.

Once moves are done, the repository is their result. Lint then checks only the moves that remain, does not ask for a new simulation, and measures the goal against the `result.before` the plan started from.

## Approve and execute

```bash
metator arch plan approve break-the-pricing-cycle        # you; never an agent (the hook refuses it)
metator arch plan run break-the-pricing-cycle            # the next wave: one W3 refactor run per move
metator arch plan status break-the-pricing-cycle         # read the runs back: done, blocked
```

- The approval records who approved and a digest of the moves. Editing a move afterwards (not its reason) needs a new approval, and `arch plan run` refuses until then.
- `run` starts each move of the next wave as an `mt-refactor` run in its own worktree. The task names the move, its reason and its evidence. Drive the runs as usual (`metator run drive`, `metator ui`).
- `status` marks a move done when its run is done, and blocked (with the run) when it was aborted or escalated. The plan is done when every move is.
- A blocked move stops its wave: `run` fails and says so. Finish or fix the move by hand, then set its `status` to `pending` (to run it again) or `done` in the plan. The status is not part of the approval, so no new approval is needed.

## Measure the planner

A planner is only as good as its plans. `docs/metator/evals/arch/` holds small monorepos with a known problem and what a good plan must fix:

```bash
metator arch eval list
metator arch eval run --host claude --min 0.8
```

A plan with a move that cannot run scores 0: its simulated result would describe a repository that cannot exist.

```json
{"summary":{"cases":2,"passed":2,"score":1},
 "cases":[{"id":"banner-imports-app","moves":1,"lintClean":true,"goalMet":true,"recall":1,"forbidden":[],"withinMoves":true,"passed":true,"score":1}, "…"]}
```

How it runs:
- Each case runs in a fresh, linked git repository, so nothing touches yours.
- The planner proposes a plan there.
- The plan is scored on five checks, the score being their mean: lint clean, goal reached, share of the expected fixes made, no forbidden violation left, at most the allowed number of moves.

Run it when you change the planner's prompt or model, the same way the review evals guard the reviewers.

## Write a policy

Without a policy you get the checks above. A policy adds your intended structure. Start from a proposal:

```bash
metator arch init
```

It writes `metator/architecture.yml` (never over an existing one): applications in a layer above every library, and the rules your tools already enforce, Turborepo `boundaries` from `turbo.json` and Nx `depConstraints` from `.eslintrc.json`. Then split the libraries into the layers you intend. Review the file like code:

```yaml
kind: ArchitecturePolicy
schemaVersion: 1
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
rules:                      # tag rules, like Nx depConstraints or Turborepo boundaries
  - from: scope:shop
    allow: [scope:shop, scope:shared]
  - from: type:ui
    deny: [type:data-access]
  - to: type:internal          # who may depend on a tag (Turborepo "dependents")
    allow: [scope:billing]
severity:
  version-drift: off
exceptions:
  - violation: "layer:@shop/money→@shop/cart"   # an id from the report; * matches any text
    reason: "price rules move to @shop/pricing in Q1"
    owner: "@shop-platform"
    expires: 2027-03-31
```

- Tags also come from the packages themselves: Nx `project.json#tags` and `package.json#nx.tags`, Turborepo `turbo.json#tags`. Nx `projectType: application` marks an application.
- An exception covers a violation until it expires. After that the violation counts again and the expired exception is an error. An exception that matches nothing is a warning, so stale ones get removed.
- `tests` (globs) decides which files may use `devDependencies` and never make cycles. `ignore` leaves generated or vendored files out.
- `metator arch schema` prints the JSON Schema of the file for your editor.

## In CI: fail only on what a change adds

A large monorepo has violations today. Failing every pull request on all of them helps nobody. `arch check` is a ratchet: a violation fails the check only when the change adds it.

```bash
metator arch check --base main                         # not at the merge base with main → new
metator arch check --base main --sarif arch.sarif      # also a SARIF 2.1.0 log for code scanning
metator arch check --strict                            # new warnings fail too
```

A violation is not new when:
- the merge base already has it (`--base`);
- the baseline accepted it;
- a policy exception covers it.

```bash
metator arch baseline             # accept what is there now: metator/arch-baseline.json
metator arch baseline --tighten   # drop what was fixed; never accepts anything new
```

Commit the baseline. `arch check` lists baseline entries that no longer occur under `fixed`, so you can tighten it in the same pull request that fixes them.

In a gate, add the step `{ metator: arch check }`. The gate passes its `--base`:

```yaml
gates:
  full:
    - id: packages
      run: { metator: arch check }
```

Upload the SARIF log to GitHub code scanning, so new violations show up on the pull request:

```yaml
      - run: metator arch check --base origin/main --sarif arch.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with: { sarif_file: arch.sarif, category: metator-arch }
```
