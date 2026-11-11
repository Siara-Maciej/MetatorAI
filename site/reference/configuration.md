# Configuration

MetatorAI reads `metator.config.yml` (or `.yaml`, `.json`) from the repository root. Every field is optional: with no file, every default applies. `metator setup` writes a first version from what it finds in the repository, and `metator init` does only that step.

```bash
metator config show      # the resolved paths, globs and gates, with the file they came from
metator config schema    # the JSON Schema, for editor completion
```

A file that does not match the schema stops every command with `INVALID_CONFIG` and the name of the wrong field.

## Example

```yaml
kind: MetatorConfig
schemaVersion: 11

gates:
  quick:
    - id: lint
      run: { bin: biome, args: [check, --no-errors-on-unmatched] }
      files: append
      match: ["**/*.{ts,tsx,js,json}"]
    - id: rules
      run: { metator: rules check }
  full:
    - id: typecheck
      run: { script: typecheck }
    - id: test
      run: { metator: test affected }
    - id: coverage
      run: { metator: coverage diff --min 80 }

project:
  sourceIgnores: ["**/node_modules/**", "**/dist/**", "**/generated/**"]

hosts:
  targets: [copilot, claude]
  metatorCommand: npx metator

notify:
  command: notify-send "MetatorAI" "$METATOR_NOTIFY_TEXT"

mcp:
  github:
    command: github-mcp-server
    args: [stdio]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }

intake:
  rules:
    - id: bugs
      source: { kind: github, repo: acme/shop, labels: [bug] }
      workflow: mt-bugfix

reviews:
  sources:
    - { kind: github, repo: acme/shop, author: alice }

options:
  supervisor.wipLimit: 2
```

The current `schemaVersion` is 11. A file with an older version still loads: MetatorAI upgrades it in memory and leaves the file as it is.

## Gates

`gates.quick` and `gates.full` are lists of steps. `metator gate quick` runs the first list, `metator gate full` (or `gate all`) the second. Agents and CI run the same commands. See [Gates and CI](../repo/gates-ci.md) for how to choose the steps.

A step has an `id` and a `run`, which is one of:

| `run` | What runs | Example |
|---|---|---|
| `{ script: <name> }` | a `package.json` script, through your package manager | `{ script: lint }` |
| `{ bin: <name>, args: [...] }` | a binary from `node_modules/.bin` | `{ bin: tsc, args: [--noEmit] }` |
| `{ workspaces: <name> }` | the script in every workspace package that has it | `{ workspaces: typecheck }` |
| `{ metator: <check> }` | a MetatorAI check, in process | `{ metator: graph diff }` |

The checks a `metator` step can run: `rules check`, `test affected`, `graph diff`, `arch check`, `contract diff`, `api diff <package>`, `coverage diff [--min <percent>] [--lcov <file>]`.

Other step fields:

| Field | Default | Use |
|---|---|---|
| `files` | `none` | `append` adds the gate's files as arguments, for tools that check single files |
| `match` | all files | with `files: append`, pass only files that match these globs |
| `okExitCodes` | `[0]` | for a tool that exits 1 when it only reports findings |
| `timeoutMs` | `600000` | stops a step that hangs |

```bash
metator gate quick --base main         # on the files changed against main
metator gate quick --files src/a.ts    # on named files
metator gate full
```

## Project

| Field | Default | Use |
|---|---|---|
| `project.sourceIgnores` | `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/coverage/**`, `.metator/**`, `**/*.d.ts` | files the import graph and the knowledge scans never read |
| `project.testGlobs` | `*.test.*` and `*.spec.*` files, `*.e2e-spec.*`, `__tests__/`, scripts under `test/`, `tests/` or `spec/` | what counts as a test |

## Hosts

| Field | Default | Use |
|---|---|---|
| `hosts.targets` | `[copilot, claude]` | the hosts `metator generate` writes agents, skills and hooks for |
| `hosts.metatorCommand` | `metator` | how agents and hooks call the CLI, for example `npx metator` or `bun run metator` |
| `hosts.models` | none | a model per tier (`reasoning`, `standard`, `fast`) and host, for example `reasoning: { claude: <model> }` |

## Paths

Override any of these under `paths:`.

| Key | Default | Holds |
|---|---|---|
| `workflows` | `.github/metator/workflows` | workflow specs |
| `runs` | `.metator/runs` | run state, logs, artifacts |
| `index` | `.metator/index` | the import index and the pattern index |
| `rules` | `docs/metator/rules` | the rules |
| `instructions` | `.github/instructions` | generated Copilot instructions |
| `memoryMap` | `docs/metator/memory-map.yml` | the memory map |
| `cards` | `docs/metator/modules` | module cards |
| `patterns` | `docs/metator/patterns` | the pattern catalog |
| `adr` | `docs/adr` | architecture decision records |
| `discovery` | `.metator/discovery.json` | what `metator discover` found |
| `gates` | `.metator/gates` | gate reports |
| `agents` | `metator/agents` | agent definitions |
| `evals` | `docs/metator/evals/golden` | review cases for `metator eval` |

## System

`system` connects this repository to a map of several applications. See [Systems of applications](../repo/systems.md).

| Field | Use |
|---|---|
| `system.map` | where the map is: `{ path: ... }` in this repository, or `{ repo, ref, path }` in another one (`path` defaults to `docs/metator/system.yml`) |
| `system.roots` | application id to its local checkout, relative to this repository or absolute |
| `system.self` | which applications of the map this repository is; found from its remote or path when unset |

## Notifications

`notify.command` is a shell command that tells you something waits. It runs for a question that waits for a person, once per question. It also runs when a review of your own pull request brings new threads.

The command runs through `sh -c` in the repository root, with these variables:

| Variable | Value |
|---|---|
| `METATOR_EVENT` | `question` or `review` |
| `METATOR_NOTIFY_TEXT` | one line that says what waits |
| `METATOR_RUN` | the run id |
| `METATOR_QUESTION_ID` | the question's id, for example `q001` |
| `METATOR_QUESTION_PROMPT` | the question's text; for a review, the same line as `METATOR_NOTIFY_TEXT` |
| `METATOR_QUESTION` | the whole question as JSON |
| `METATOR_REVIEW_ID` | for a review: the request's id, as `metator mrs list` names it |
| `METATOR_REVIEW_NUMBER` | for a review: the request's number at the host |
| `METATOR_REVIEW_TITLE` | for a review: the request's title |
| `METATOR_REVIEW_URL` | for a review: the request's address |

```yaml
notify:
  # a desktop notification
  command: notify-send "MetatorAI" "$METATOR_NOTIFY_TEXT"
  # or a chat webhook
  # command: curl -s -X POST -H 'Content-Type: application/json' -d "{\"text\": \"$METATOR_NOTIFY_TEXT\"}" "$CHAT_WEBHOOK"
```

A question that an answer policy answers is not announced. A failing command never stops a run. For a question, the failure is a line in the run's activity and the command is tried again the next time the run is driven. For a review, the failure is listed under `errors` of `metator mrs scan`.

## MCP servers

`mcp` names the MCP servers the agents may use in this repository. `metator generate` writes them into `.mcp.json`, which Claude Code and Copilot CLI read.

```yaml
mcp:
  github:
    command: github-mcp-server        # started by command
    args: [stdio]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
  tracker:
    url: https://mcp.example.com/mcp  # or reached by URL
```

| Field | Use |
|---|---|
| `command`, `args` | the process to start |
| `url` | the address of a remote server; a server needs a `command` or a `url` |
| `env` | variables the server gets; a value is a literal or `${VAR}` |

::: warning
Write `${VAR}` in `env`, never a token. `metator.config.yml` and `.mcp.json` are committed. The host fills `${VAR}` from your environment when it starts the server.
:::

Entries of `.mcp.json` that MetatorAI did not write are kept. A server you remove from `mcp` stays in `.mcp.json` until you delete it there. Servers under `mcp:` in your own options file (see [Options](#options)) are added to the repository's, and win when the names match.

## Intake

`intake` holds the rules that turn issues from GitHub, GitLab or Jira into tasks and runs. `metator intake scan` applies them once, and the daemon applies them on a timer. See [Automatic intake](../use/intake.md).

| Field | Default | Use |
|---|---|---|
| `intake.everyMs` | `120000` | how often the daemon scans |
| `intake.maxActive` | `2` | runs started by intake that may be active at once; further items wait as open tasks |
| `intake.rules[].id` | | the rule's name: lowercase letters, digits, dashes; unique |
| `intake.rules[].source.kind` | | `github`, `gitlab` or `jira` |
| `intake.rules[].source.repo` | | `owner/name` on GitHub, the project path on GitLab |
| `intake.rules[].source.project` | | the Jira project key |
| `intake.rules[].source.labels` | `[]` | only items with these labels |
| `intake.rules[].source.type` | | the Jira issue type, for example `Bug` |
| `intake.rules[].source.state` | `open` | only items in this state |
| `intake.rules[].source.mcp` | the kind's name | the server under `mcp:` that reaches the source |
| `intake.rules[].source.tool` | the kind's usual tool | the server's tool that lists the items |
| `intake.rules[].workflow` | | the workflow a new item starts, for example `mt-bugfix` |
| `intake.rules[].autonomy` | `gated` | `gated`: every gate of the workflow asks a person. `full`: gates marked `skipAt` pass; a push still asks |
| `intake.rules[].worktree` | `true` | each run works in its own worktree |

## Reviews

`reviews` says where to look for reviews of your own pull requests. A new review starts a run that proposes replies and changes. See [Answer a review](../use/reviews.md).

| Field | Default | Use |
|---|---|---|
| `reviews.everyMs` | `120000` | how often the daemon looks |
| `reviews.sources[].kind` | | `github` or `gitlab` |
| `reviews.sources[].repo` | | `owner/name` on GitHub, the project path on GitLab |
| `reviews.sources[].author` | every open request | only requests of this author |
| `reviews.sources[].mcp` | the kind's name | the server under `mcp:` that reaches the host |
| `reviews.workflow` | `mt-review-response` | the workflow a new review starts |

## Supervisor

`supervisor` is what `metator supervise` and the daemon follow to keep sessions alive.

| Field | Default | Use |
|---|---|---|
| `wipLimit` | `4` | how many runs may wait for a person at once before a new one starts with a warning |
| `respawn.enabled` | `true` | start a run's session again when its process dies |
| `respawn.maxAttempts` | `3` | restarts of one run before the supervisor gives up and says so |
| `idleThresholdMs` | `90000` | no terminal output for this long, with no open question, counts as idle |
| `hostOrder` | `[copilot, claude, opencode]` | which interactive host a new session takes first |
| `chatApprovals` | `attached-only` | an approval said in the chat counts only while a person is attached to the session (the only value) |

## Options

An option is one key with a type, a default and a scope. Options cover the desktop app, the terminals, the daemon and a few repository policies. A lower scope in this table overrides the ones above it.

| Scope | File | For |
|---|---|---|
| `user` | `~/.config/metator/options.yml` | your look, keys and editor, on every repository |
| `repo` | `options:` in `metator.config.yml` | the repository's policy |
| `run` | `options` in the run's `state.json` | a value recorded with one run (`--scope run --run <id>`); the options shipped today are read for the whole repository, so a run's value shows in `config get --run <id>` and changes nothing else |

```bash
metator config list                                    # every option: value and where it comes from
metator config list --changed                          # only the ones a file sets
metator config get keys.zoom                           # one option, its description and default
metator config set ui.paneBorders always --scope user
metator config set supervisor.wipLimit 2 --scope repo
metator config unset ui.paneBorders --scope user       # back to the next scope, or the default
metator config schema --options                        # the JSON Schema of the options
```

| Group | Scope | Keys |
|---|---|---|
| `ui` | user | `paneBorders`, `paneLabels`, `statusIndicators`, `confirmClosePane`, `attachOnType` |
| `keys` | user | `prefix` (default `ctrl+b`), then one key per action: `newShell`, `newTab`, `splitRight`, `splitDown`, `zoom`, `focusLeft`, `focusDown`, `focusUp`, `focusRight`, `goto`, `nextWaiting`, `attach`, `release`, `copyMode`, `closePane`, `plan`, `changes`, `backlog`, `help` |
| `notify` | user | `channel` (`app` or `off`: whether the app shows a toast for a waiting question) |
| `notify` | repo | `command` (empty by default: no command runs) |
| `terminal` | user | `shell`, `scrollbackLines` |
| `editor` | user | `command` |
| `supervisor` | repo | `wipLimit`, `respawn`, `respawnAttempts`, `idleThresholdMs`, `hostOrder` |
| `issues` | repo | `requireConsent`, `proposeFromAgents` |

Every option on this list changes what MetatorAI does. `metator config list` prints the same list with each option's description and default.

A key binding is written as the prefix and one key, for example `prefix+z` for zoom: press the prefix, then `z`.

The desktop app's **Settings** screen shows the same list. A change there is written to the same files.

A wrong value in a file stops nothing: the default applies and `metator config list` reports the value as a diagnostic. A wrong value typed into `config set` is refused with `USAGE`. The `supervisor.*` options and `notify.command` are read when `metator serve` starts, so restart the daemon after you change them. `issues.requireConsent` is always on: an agent proposes a task and a person adds it.

The top-level fields `editor`, `notify.command` and `supervisor` count as the repository's values of `editor.command`, `notify.command` and the `supervisor.*` options. A value under `options:` wins over them.

## Git ignore

Add the working state to `.gitignore`:

```text
.metator/
```

Everything else MetatorAI writes (rules, cards, agents, generated host files) is meant to be committed and reviewed.
