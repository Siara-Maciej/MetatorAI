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
  # Default: *.test.* and *.spec.* files, *.e2e-spec.*, __tests__/, any script under test/,
  # tests/ or spec/ (mocha's test/app.js, ava's test/main.ts), and a single test.js or test.ts. Set it only to narrow or widen that.
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

# A command run when a question waits for you (see "Notifications" below).
notify:
  command: notify-send "MetatorAI" "$METATOR_QUESTION_PROMPT"

# The supervisor (see "Supervisor" below); every field has a default.
supervisor:
  wipLimit: 4                              # runs that may wait for you at once before new ones warn
  respawn: { enabled: true, maxAttempts: 3 }
  idleThresholdMs: 90000                   # no terminal output for this long, no open question: idle
  hostOrder: [copilot, claude, opencode]
  chatApprovals: attached-only
```

Older files (`schemaVersion` 1 to 6) still load: MetatorAI upgrades them in memory.

## Notifications

`notify.command` runs (through `sh -c`, in the repository) each time a question starts waiting for a person, once per question, so a run does not stand still while nobody looks at the terminal. It gets:

| Variable | Value |
|---|---|
| `METATOR_RUN` | the run id |
| `METATOR_QUESTION_ID` | `q001`, … |
| `METATOR_QUESTION_PROMPT` | the question's text |
| `METATOR_QUESTION` | the whole question as JSON, its decision card included |

```yaml
notify:
  # a desktop notification
  command: notify-send "MetatorAI" "$METATOR_QUESTION_PROMPT"
  # or a chat webhook (Slack, Teams, …)
  # command: curl -s -X POST -H 'Content-Type: application/json' -d "{\"text\": \"$METATOR_RUN: $METATOR_QUESTION_PROMPT\"}" "$CHAT_WEBHOOK"
```

A question an answer policy answers is not announced. A failing command is logged in the run's activity and never stops the run; the next drive tries again.

## Supervisor

`supervisor` is the policy `metator supervise` and the daemon follow (ADR-0077):

| Field | Default | What it does |
|---|---|---|
| `wipLimit` | 4 | how many runs may wait for a person at once; `run init` warns past it, the inbox shows the count |
| `respawn.enabled`, `respawn.maxAttempts` | true, 3 | a drive that died is started again at its stage, this many times; then the run's activity says the supervisor gave up |
| `idleThresholdMs` | 90000 | an interactive session with no output for this long and no open question is idle: nudged once, then a person is asked |
| `hostOrder` | copilot, claude, opencode | which interactive host a new session takes first |
| `chatApprovals` | attached-only | an approval said in the chat counts only while the person is attached (the only value today) |

## Gates

A gate is a named list of steps. A step runs one of:

| `run` | Meaning | Example |
|---|---|---|
| `{ script: <name> }` | a `package.json` script through your package manager | `{ script: lint }` |
| `{ bin: <name>, args: [...] }` | a binary from `node_modules/.bin` (from PATH only when the project has none; with dependencies not installed it is reported missing, never run in another version from PATH) | `{ bin: tsc, args: [--noEmit] }` |
| `{ workspaces: <name> }` | the script in every workspace package that has it, through your package manager (`pnpm -r --if-present run <name>`, `npm run <name> --workspaces --if-present`, `bun run --filter '*' <name>`, `yarn workspaces foreach -A run <name>`) | `{ workspaces: typecheck }` |
| `{ metator: <check> }` | a MetatorAI check in process | `rules check`, `test affected`, `graph diff`, `arch check`, `contract diff`, `api diff <package>`, `coverage diff [--min N] [--lcov file]` |

Other step fields:

| Field | Default | Why |
|---|---|---|
| `files` | `none` | `append` passes the gate's files, for file-scoped tools in `quick` |
| `match` | all files | with `files: append`, pass only files the tool understands |
| `okExitCodes` | `[0]` | a tool that exits 1 when it only reports findings |
| `timeoutMs` | `600000` | stop a hanging step |

`metator init` proposes the steps from your own scripts. When TypeScript is configured at the root but no script type-checks (a build that only transpiles, such as `nest build`), it proposes `{ bin: tsc, args: [--noEmit, -p, tsconfig.json] }` for `full`, so a type error cannot pass every gate. In a monorepo whose packages type-check or test with their own script and no root script runs them, it proposes `{ workspaces: <that script> }` instead. Workspace packages come from `package.json#workspaces` or `pnpm-workspace.yaml`; a package whose `package.json` has no `name` (an app never published, a proxy folder) is named after its directory, and a root with a framework config (`nuxt.config.ts`, `next.config.js`, …) is a package beside its workspaces. Without any workspace, two or more projects side by side (`user/package.json`, `mailer/package.json`; not tests, fixtures, examples or docs) are packages each; `init` then proposes no `{ workspaces: … }` step, since the package manager runs nothing across them. A script that type-checks one sub-project (`tsc -p tsconfig.tracker.json`) is not taken as the project's typecheck: with a root `tsconfig.json`, `init` proposes `tsc --noEmit -p tsconfig.json`. A task runner's task is read by its whole name: `turbo run test:e2e` runs end-to-end tests, so a root `ci` script that builds and runs it is the e2e gate, not the unit tests.

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
| `adr` | `docs/adr` | architecture decisions; `metator init` writes it when it finds them elsewhere (`adr/`, `docs/decisions`) |
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
