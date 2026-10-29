# Configuration

MetatorAI reads `metator.config.yml` (or `.yaml`, `.json`) from the repository root. Every field is optional: an empty file, or no file at all, means every default. `metator setup` (or `metator init` on its own) proposes a first version from evidence.

```bash
metator config show      # the resolved configuration, defaults included
metator config schema    # JSON Schema, e.g. for editor completion
```

## A complete example

```yaml
kind: MetatorConfig
schemaVersion: 4

# Quality gates: your own checks, run by `metator gate quick|full` and by agents.
gates:
  quick:                                   # fast, on the files an agent just changed
    - id: lint
      run: { bin: biome, args: [check, --no-errors-on-unmatched] }
      files: append                        # the changed files are appended as arguments
      match: ["**/*.{ts,tsx,js,json}"]     # only files the linter understands
    - id: rules
      run: { metator: rules check }        # MetatorAI's own check, in process
  full:                                    # before review and in CI
    - id: typecheck
      run: { script: typecheck }           # package.json script, run by your package manager
    - id: test
      run: { metator: test affected }      # only the tests the change reaches
    - id: graph
      run: { metator: graph diff }         # new cross-package edges and new cycles
    - id: coverage
      run: { metator: coverage diff --min 80 }   # coverage of the lines added on the branch

# Where knowledge and state live (defaults shown for a few).
paths:
  rules: docs/metator/rules
  workflows: .github/metator/workflows

# What the import graph and knowledge scans ignore, and what counts as a test.
project:
  sourceIgnores: ["**/node_modules/**", "**/dist/**", "**/generated/**"]
  testGlobs: ["**/*.test.ts", "**/__tests__/**"]

# Generated host files.
hosts:
  targets: [copilot, claude]
  metatorCommand: metator                  # how agents and hooks call the CLI
  models:                                  # optional: a model per tier and host
    reasoning: { claude: your-reasoning-model }
    fast: { copilot: your-fast-model }

# The editor `metator ui` opens a run's worktree in; set the first time you pick one.
editor: code                               # or "code --new-window", cursor, zed, nvim, ...

# A system of many applications (see "Systems of many applications").
system:
  map: { repo: github.com/shop/platform, ref: v3, path: docs/metator/system.yml }   # the map in a platform repository
  roots: { billing: ../billing }           # local checkouts of other applications
  self: [web]                              # which applications this repository is (found from the map when unset)
```

Older files (`schemaVersion` 1 to 3) still load: MetatorAI upgrades them in memory.

## Gates

A gate is a named list of steps. A step runs one of:

| `run` | Meaning | Example |
|---|---|---|
| `{ script: <name> }` | a `package.json` script through your package manager | `{ script: lint }` |
| `{ bin: <name>, args: [...] }` | a binary from `node_modules/.bin` | `{ bin: tsc, args: [--noEmit] }` |
| `{ metator: <check> }` | a MetatorAI check in process | `rules check`, `test affected`, `graph diff`, `arch check`, `contract diff`, `api diff <package>`, `coverage diff [--min N] [--lcov file]` |

Other step fields:

| Field | Default | Why |
|---|---|---|
| `files` | `none` | `append` passes the gate's files, for file-scoped tools in `quick` |
| `match` | all files | with `files: append`, pass only files the tool understands |
| `okExitCodes` | `[0]` | a tool that exits 1 when it only reports findings |
| `timeoutMs` | `600000` | stop a hanging step |

```bash
metator gate quick --base main           # quick gate on the files changed on the branch
metator gate quick --files src/a.ts      # or on explicit files
metator gate full                        # full gate (alias: gate all)
```

## Paths

All defaults, overridable under `paths:`:

| Key | Default | Holds |
|---|---|---|
| `workflows` | `.github/metator/workflows` | workflow specs |
| `runs` | `.metator/runs` | run state, logs, artifacts |
| `index` | `.metator/index` | import index and pattern index (derived, git-ignored) |
| `rules` | `docs/metator/rules` | the rule canon |
| `instructions` | `.github/instructions` | generated Copilot instructions |
| `memoryMap` | `docs/metator/memory-map.yml` | the memory map |
| `cards` | `docs/metator/modules` | module cards |
| `patterns` | `docs/metator/patterns` | the pattern catalog |
| `adr` | `docs/adr` | architecture decisions |
| `gates` | `.metator/gates` | gate reports |
| `agents` | `metator/agents` | canonical agents |
| `evals` | `docs/metator/evals/golden` | golden review cases |

## Environment variables

| Variable | Effect |
|---|---|
| `METATOR_NOW` | pin the clock (ISO time) for reproducible run ids and logs, e.g. in tests |
| `METATOR_ROLE` | `coordinator` makes `guard pre-tool` deny code edits by the calling agent |

## Git ignore

Add the working state to `.gitignore`; it is derived or per-run:

```text
.metator/
```

Everything else MetatorAI writes (canon, cards, generated host files) is meant to be committed and reviewed.
