# Quality gates and CI

**Goal:** agents, developers and CI run the same checks, and a change that breaks rules, tests or architecture never reaches review.

## The two gates

| Gate | When | Typical steps |
|---|---|---|
| `quick` | after every edit, on the changed files | linter on the files, `rules check`, typecheck |
| `full` | before review and in CI | lint, typecheck, `test affected`, `graph diff`, `coverage diff` |

```bash
metator gate quick --base main
metator gate full
```

The report is written to `.metator/gates/<gate>.json`, and the review stage cites it. Configure the steps in [Configuration](../guide/configuration.md#gates).

## Checks worth adding

```bash
metator test affected --base main            # only the tests the import graph says the change reaches
metator graph diff --base main               # added/removed import edges, new package dependencies, new cycles
metator coverage diff --base main --min 80   # coverage of the lines added on the branch (LCOV)
metator api diff @shop/money                 # public API changed since the snapshot
metator flaky check src/a.test.ts --runs 5   # the test decides the same way every time
metator debug-tags check --base main         # no instrumentation left
```

**Why `test affected`:** on a large repo running every test on every edit is slow; running none is dangerous. The import graph gives the exact set.

**Why `graph diff`:** a new dependency from `billing` to `web`, or a new import cycle, is an architecture decision. It shows up in the gate instead of three months later.

## GitHub Actions

The gate runs your scripts with the package manager MetatorAI detected, so the job installs your dependencies the way you do locally:

::: code-group

```yaml [npm]
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
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Install MetatorAI                  # runs on Bun, whatever your project uses
        run: |
          git clone --depth 1 https://github.com/Siara-Maciej/MetatorAI.git "$RUNNER_TEMP/metatorai"
          (cd "$RUNNER_TEMP/metatorai" && bun install && cd packages/cli && bun link)
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
      - run: metator index build
      - run: metator gate full
      - run: metator meta check-all --min-e1 60   # canon, memory, cards, agents, workflows, generated files
```

```yaml [pnpm]
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
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Install MetatorAI                  # runs on Bun, whatever your project uses
        run: |
          git clone --depth 1 https://github.com/Siara-Maciej/MetatorAI.git "$RUNNER_TEMP/metatorai"
          (cd "$RUNNER_TEMP/metatorai" && bun install && cd packages/cli && bun link)
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
      - run: metator index build
      - run: metator gate full
      - run: metator meta check-all --min-e1 60   # canon, memory, cards, agents, workflows, generated files
```

```yaml [yarn]
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
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable && yarn install --immutable   # Yarn 1: yarn install --frozen-lockfile
      - name: Install MetatorAI                  # runs on Bun, whatever your project uses
        run: |
          git clone --depth 1 https://github.com/Siara-Maciej/MetatorAI.git "$RUNNER_TEMP/metatorai"
          (cd "$RUNNER_TEMP/metatorai" && bun install && cd packages/cli && bun link)
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
      - run: metator index build
      - run: metator gate full
      - run: metator meta check-all --min-e1 60   # canon, memory, cards, agents, workflows, generated files
```

```yaml [bun]
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
      - run: bun install --frozen-lockfile
      - name: Install MetatorAI                  # runs on Bun, whatever your project uses
        run: |
          git clone --depth 1 https://github.com/Siara-Maciej/MetatorAI.git "$RUNNER_TEMP/metatorai"
          (cd "$RUNNER_TEMP/metatorai" && bun install && cd packages/cli && bun link)
          echo "$HOME/.bun/bin" >> "$GITHUB_PATH"
      - run: metator index build
      - run: metator gate full
      - run: metator meta check-all --min-e1 60   # canon, memory, cards, agents, workflows, generated files
```

:::

## One command for the whole canon

```bash
metator meta check-all --min-e1 60
```

It runs, in one process and with one report:

- `rules lint`, `rules adapters --check`, `rules coverage`;
- `memory check`, `memory dupes --check`;
- `cards build --check`, `patterns scan --check`, `adr lint`;
- `meta agents-lint`, `meta skills-lint`;
- `workflow validate`, `workflow lint`;
- `generate --check`;
- `docs links`, `docs drift`, `system lint`.

Each failing check is named with its error.
