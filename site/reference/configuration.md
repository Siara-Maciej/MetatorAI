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
schemaVersion: 15

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

codehost:
  sources:
    - { id: shop, kind: github, repo: acme/shop, via: "mcp:github", author: alice }
  review: { autoPublish: false, watch: true, everyMs: 120000 }
  mine: { analyse: false }

intake:
  rules:
    - id: bugs
      source: shop
      labels: [bug]
      workflow: mt-bugfix

guard:
  commands:
    never: [git push --force*, git reset --hard, git clean -f]
    ask: [git commit, git push, git merge, git rebase]

quick:
  maxFiles: 5
  maxLines: 150

options:
  supervisor.wipLimit: 2
```

The current `schemaVersion` is 15. A file with an older version still loads: MetatorAI upgrades it in memory and leaves the file as it is.

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

Override any of these under `paths:`. Local state (runs, the index, gate reports, what `metator discover` found) always lives under `.metator/` and has no key here: git, the hooks and a run's worktree treat that directory as MetatorAI's own. A file older than version 12 that sets `runs`, `index`, `discovery` or `gates` still loads, and the key is ignored.

| Key | Default | Holds |
|---|---|---|
| `workflows` | `.github/metator/workflows` | workflow specs |
| `rules` | `docs/metator/rules` | the rules |
| `instructions` | `.github/instructions` | generated Copilot instructions |
| `memoryMap` | `docs/metator/memory-map.yml` | the memory map |
| `cards` | `docs/metator/modules` | module cards |
| `patterns` | `docs/metator/patterns` | the pattern catalog |
| `adr` | `docs/adr` | architecture decision records |
| `agents` | `metator/agents` | agent definitions |
| `evals` | `docs/metator/evals/golden` | review cases for `metator eval` |

## System

`system` connects this repository to a map of several applications. See [Systems of applications](../many/systems.md).

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

Entries of `.mcp.json` that MetatorAI did not write are kept. A server you remove from `mcp` stays in `.mcp.json` until you delete it there. Servers under `mcp:` in your own options file (see [Options](#options)) are yours alone: MetatorAI uses them for intake, reviews of your requests and `metator doctor`, where they are added to the repository's and win when the names match. `metator generate` does not write them into `.mcp.json`, because that file is committed. To give your own server to the agents of a host, add it to that host's own user configuration.

## Intake

`intake` holds the rules that turn issues from GitHub, GitLab or Jira into tasks and runs. `metator intake scan` applies them once, and the daemon applies them on a timer. See [Automatic intake](../repo/intake.md).

| Field | Default | Use |
|---|---|---|
| `intake.everyMs` | `120000` | how often the daemon scans |
| `intake.maxActive` | `2` | runs started by intake that may be active at once; further items wait as open tasks |
| `intake.rules[].id` | | the rule's name: lowercase letters, digits, dashes; unique |
| `intake.rules[].source` | | the id of a source in `codehost.sources` |
| `intake.rules[].labels` | `[]` | only items with these labels |
| `intake.rules[].type` | | the Jira issue type, for example `Bug` |
| `intake.rules[].state` | `open` | only items in this state |
| `intake.rules[].tool` | the kind's usual tool | the server's tool that lists the items |
| `intake.rules[].workflow` | | the workflow a new item starts, for example `mt-bugfix` |
| `intake.rules[].autonomy` | `gated` | `gated`: every gate of the workflow asks a person. `full`: gates marked `skipAt` pass; a push still asks |
| `intake.rules[].worktree` | `true` | each run works in its own worktree |

## Code hosts

`codehost` (version 15) is the one list of the code hosts MetatorAI reads, for intake and for reviews, with how each is read; what happens to a review of someone else's request; and whether a review of yours is analysed by itself. Tokens are never here: they stay in the MCP server's configuration or in `gh auth login`. See [Reviews](../use/reviews.md#review-a-pull-request-from-its-link).

| Field | Default | Use |
|---|---|---|
| `codehost.sources[].id` | | the source's name: lowercase letters, digits, dashes; unique |
| `codehost.sources[].kind` | | `github`, `gitlab` or `jira` |
| `codehost.sources[].repo` | | `owner/name` on GitHub, the project path on GitLab |
| `codehost.sources[].project` | | the Jira project key |
| `codehost.sources[].via` | | `mcp:<server>` (a server under `mcp:`), or `gh` (GitHub only, with gh's own login) |
| `codehost.sources[].author` | every open request | your requests are this author's (reviews of your own requests) |
| `codehost.review.autoPublish` | `false` | publish a review without the card "Publish the review of MR #N?" (the approval gate is skipped) |
| `codehost.review.watch` | `true` | follow reviewed requests and the ones you are asked to review for new commits and replies |
| `codehost.review.everyMs` | `120000` | how often the daemon looks at the watched requests |
| `codehost.mine.analyse` | `false` | a new review of your request starts `reviews.workflow` by itself; off, a card with **Analyse** waits |

A version 14 file loads as version 15: `reviews.sources` and each `intake.rules[].source` move to `codehost.sources`, the rules name them by id, and an `ask` list you wrote gets `metator review approve`.

## Reviews

`reviews` says how reviews of your own pull requests are answered. Where they are is `codehost.sources`.

| Field | Default | Use |
|---|---|---|
| `reviews.everyMs` | `120000` | how often the daemon looks |
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

## Guard

`guard.commands` is the one list of dangerous shell commands, enforced the same way on Claude Code and Copilot CLI by the [`pre-tool` hook](./hooks.md), for every agent: the chat, a run's conductor and its workers. Only a person changes it, by editing this file; an agent cannot relax it.

| Field | Default | Use |
|---|---|---|
| `guard.commands.never` | `git push --force*`, `git push -f`, `git reset --hard`, `git clean -f`, `git rebase -i`, `git rebase --interactive`, `git filter-branch`, `git filter-repo`, and `rm -r` of `/`, `/*`, `~`, `.`, `..`, `*` or `.git` | never run by an agent: the call is denied with the reason. You run such a command yourself |
| `guard.commands.ask` | `git commit`, `git push`, `git merge`, `git rebase`, `metator review approve` | run only with your consent: a click on your host's own approval prompt, or your word in the chat ("commit", "push it", "zacommituj") |
| `guard.commands.allow` | none | commands that `ask` would catch and that you allow anyway, for example `git commit --fixup` |
| `guard.consentMinutes` | `10` | how long a consent you gave in words holds; it is used up by the first command of that kind |
| `guard.prompts` | `metator` | who answers your host's approval prompt for what is known to be safe: `metator` lets the four kinds below run without a prompt; `host` keeps your host's own prompts for everything (the guard then only denies and asks) |

A pattern is the command's words: the program, for `git` the subcommand, then the flags or words that must be among the arguments. `--force*` also matches `--force-with-lease`; `-f` also matches inside `-xdf`. `never` wins over `ask`, and `allow` lifts only `ask`.

A consent in words comes from your own message only (the host's user-prompt hook hands it to `metator guard user-prompt`). A question ("should we commit?"), a refusal, the agent's own words and lines MetatorAI types (`[metator] …`) give none. In a run, the approval of the delivery gate (`metator run approve push`) counts as your consent to that run's commit and push. A session without a terminal (`metator run drive`) cannot ask you, so there a command on `ask` needs the run's approval.

A `git commit` that would hold a recorded debug change (see [Debug changes](../use/quick.md#debug-changes)) is stopped with the files, even after "commit": say "commit anyway", or remove the changes first.

### What runs without a prompt

With `guard.prompts: metator` the `pre-tool` hook answers `allow`, with the reason, for four kinds of calls, on both hosts. Everything else keeps your host's own approval prompt, and `never` and `ask` are judged first and win.

| Kind | What qualifies |
|---|---|
| MetatorAI's own commands | `metator …` as the repository runs it (`hosts.metatorCommand`, `npx metator`, `bun run metator`), any subcommand except the ones that are your decision: `run approve`, `run answer`, `run resume`, `run take`, `run close`, `system plan approve`, `system plan retry`, `arch plan approve`, `scratch forget`, `policy`, `config set`, `config unset`, `issue add`, `setup`, `init`, `generate`, `agents`, `serve`, `mcp`, `findings to-github`, `mrs send`, `mrs resolve`, `review approve`, and `quick start --override`. Those are asked about by name. `metator guard` is never an agent's command |
| Commands that only read | `git status`, `git diff`, `git log`, `grep`, `rg`, `ls`, `cat`, `head`, `sed -n '1,80p' file` and the like, with paths inside the repository; no option that writes or runs something |
| Edits inside the repository | a file edit or write whose every path is inside the repository (in a run: inside its plan's scope), except `.git/`, `metator.config.*`, `.claude/settings*.json`, `.github/hooks/`, and MetatorAI's own records under `.metator/` (a run's artifacts are fine). Secrets are denied as always |
| The repository's own checks | the steps of `gates.quick` and `gates.full` (a script through `bun`, `npm`, `pnpm` or `yarn`; a binary with its arguments, also through `npx` or `bunx`), and the package's `test`, `typecheck`, `lint` and `build` scripts or the command such a script runs (`bunx tsc --noEmit`) |

A chain or a pipeline passes only when every part of it qualifies (`git status --short && bun test`, `bun test 2>&1 | tail -20`). A command substitution, a redirection to a file, a path outside the repository, or one part that does not qualify (`git status && curl …`) leaves the whole call to your host's prompt.

Copilot CLI takes an allow list when it starts, so its sessions are also started with `--allow-tool` for MetatorAI's commands that hold none of your decisions and for the repository's check scripts. Reads and edits are not on that list (a command prefix cannot say "inside the repository"); for those Copilot's own prompt asks unless it honours the hook's answer.

## Quick

`quick` holds the limits of a quick change (`metator quick check`, see [Quick](../use/quick.md)).

| Field | Default | Use |
|---|---|---|
| `quick.maxFiles` | `5` | more changed files than this is not quick |
| `quick.maxLines` | `150` | more changed lines (added plus removed) than this is not quick |
| `quick.maxDependents` | `10` | more files that depend on the change (through imports, tests aside) than this is not quick |

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
| `backlog` | repo | `staleDays` (default 14): after how many days a task's analysis or plan reads `old`, a warning only |

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

`metator setup` adds this line. Before that, the first command that writes there (an index, a report) adds `/.metator/` to `.git/info/exclude`, which hides it from `git status` in your clone only and changes no tracked file.

Everything else MetatorAI writes (rules, cards, agents, generated host files) is meant to be committed and reviewed.
