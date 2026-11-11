# Gates and CI

A gate is a named list of checks from your configuration. Agents, you and CI run the same gate with the same command, so a change that fails in CI fails the same way on your machine. This page shows how to set the gates up and run them in GitHub Actions.

## The two gates

| Gate | When it runs | Typical steps |
|---|---|---|
| `quick` | after edits, on the changed files | linter on the files, `rules check`, typecheck |
| `full` | before review and in CI | lint, typecheck, tests, `graph diff`, `arch check` |

```bash
metator gate quick --base main        # on the files changed against main
metator gate quick --files src/a.ts   # on the files you name
metator gate full
```

The report is written to `.metator/gates/<gate>.json`.

## Configure the steps

Steps live under `gates` in `metator.config.yml`:

```yaml
gates:
  quick:
    - id: lint
      run: { bin: biome, args: [check] }
      files: append                  # pass the changed files to the tool
    - id: rules
      run: { metator: rules check }
    - id: typecheck
      run: { script: typecheck }
  full:
    - id: lint
      run: { script: lint }
    - id: typecheck
      run: { script: typecheck }
    - id: test
      run: { script: test }
    - id: graph
      run: { metator: graph diff }
    - id: packages
      run: { metator: arch check }
```

A step runs a `package.json` script with your package manager (`script`), a binary (`bin` with `args`), or a MetatorAI check in process (`metator`). The gate passes its `--base` to the MetatorAI checks. All step fields are in [Configuration](../reference/configuration.md).

## Checks you can add

| Check | Fails when |
|---|---|
| `metator rules check --base main` | a changed file breaks a tool-enforced [rule](./index.md) |
| `metator test affected --base main` | a test the import graph says the change reaches fails. It runs only those tests |
| `metator graph diff --base main` | reports import edges added and removed, new package dependencies and new cycles |
| `metator arch check --base main` | the change adds a [package architecture](./architecture.md) violation |
| `metator contract diff --base main --check` | the change breaks an API contract in a way the [system map](./systems.md) does not allow |
| `metator coverage diff --base main --min 80` | fewer than 80 percent of the added lines are covered (reads `coverage/lcov.info`) |
| `metator api diff @shop/money` | the package's public API differs from its snapshot (`metator api snapshot`) |
| `metator flaky check src/a.test.ts --runs 5` | the test file gives mixed results over five runs |
| `metator debug-tags check --base main` | a `[DEBUG-<hex>]` instrumentation marker is left in a changed file |

## Check the whole canon

```bash
metator meta check-all --min-e1 60
```

This runs every lint and drift check of the repository's knowledge in one command and reports each by name:

- `rules lint`, `rules adapters --check`, `rules coverage --min-e1 <n>` (default 40);
- `memory check`, `memory dupes --check`;
- `cards build --check`, `patterns scan --check`, `adr lint`;
- `meta agents-lint`, `meta skills-lint`;
- `workflow validate`, `workflow lint`;
- `generate --check`;
- `docs links`, `docs drift`, `system lint`.

When one fails, run that command on its own for the details.

## The GitHub action

MetatorAI ships a composite action for pull requests. It runs, in order: the rules on the changed files, the package architecture check (new violations only), the workflow lint and `generate --check`, and then your gate if you name one.

```yaml
# .github/workflows/mt-pr-review.yml
name: mt-pr-review
on: [pull_request]
permissions:
  contents: read
  security-events: write          # only for sarif: "true"
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4   # your runtime, for the gate
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: Siara-Maciej/MetatorAI@main
        with:
          gate: full
          sarif: "true"
```

| Input | Default | Meaning |
|---|---|---|
| `base` | the pull request's base branch (`HEAD~1` on a push) | the ref the change is compared against |
| `gate` | none | `quick` or `full`; empty runs no gate |
| `sarif` | `"false"` | upload the new architecture violations to code scanning |
| `metator-ref` | `main` | which MetatorAI ref to run |
| `working-directory` | the workspace | the repository to check |

The action sets two outputs: `violations` (rule violations in the change) and `arch-added` (architecture violations the change adds). It fails when either is not zero, when a workflow spec fails lint, when a generated file is stale, and when the gate fails.

## Your own job

To choose the steps yourself, install your dependencies, install MetatorAI and call the commands. The gate runs your scripts with your package manager, so the install step differs:

::: code-group

```yaml [npm]
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
```

```yaml [pnpm]
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
```

```yaml [yarn]
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable && yarn install --immutable
```

```yaml [bun]
      - run: bun install --frozen-lockfile
```

:::

The rest of the job is the same for every package manager:

```yaml
# .github/workflows/metator.yml
name: metator
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }             # merge bases need history
      - uses: oven-sh/setup-bun@v2           # MetatorAI runs on Bun
      # your install step from above goes here
      - name: Install MetatorAI
        run: |
          git clone --depth 1 https://github.com/Siara-Maciej/MetatorAI.git "$RUNNER_TEMP/metatorai"
          (cd "$RUNNER_TEMP/metatorai" && bun install && cd packages/cli && bun link)
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
      - run: metator index build
      - run: metator gate full
      - run: metator meta check-all --min-e1 60
```

## Decision records in CI

`adr lint` (part of `check-all`) reads the decision log where `paths.adr` points (default `docs/adr`). It checks numbering, status, sections and the index, and that an accepted record names the rules it implies.
