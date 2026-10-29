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

The **score** is 100 minus 5 per error and 1 per warning. Use it as a trend, not as a grade.

## What it finds

| Kind | Default | Meaning |
|------|---------|---------|
| `cycle` | error | Packages depend on each other (test-only imports never make a cycle). A cycle closed only by `import type` is a warning. |
| `undeclared` | error | A file imports a package (workspace or npm) that its `package.json` does not declare. |
| `root-only` | warning | Only the repository root declares it, so it works through hoisting and breaks when the package is used alone. |
| `dev-in-prod` | error | Non-test code imports something declared only in `devDependencies`. |
| `relative-import` | error | `../../other-package/src/x` instead of the package name. |
| `app-import` | error | A package depends on an application. |
| `unused-dependency` | warning | Declared in `dependencies`, imported by no file, not used in a script. |
| `version-drift` | warning | One dependency declared with several version ranges across packages. |
| `layer`, `unlayered`, `tag` | error, warning, error | Your policy's layers and tag rules (below). |
| `expired-exception`, `unused-exception` | error, warning | Your policy's exceptions. |

Two narrower views:

```bash
metator arch cycles     # just the cycles, with the edges inside each
metator arch declared   # just the package.json findings
```

What the analyzer cannot resolve (dynamic paths, bundler aliases outside `tsconfig`) is counted under **Limits** in the report. Those imports are not in the graph.

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
