# Troubleshooting

Find an error here by its message and get the fix. Every error has a `code` and a `message`, and usually a `hint` that names the next step. Read the hint first.

For a check of the whole setup, run:

```bash
metator doctor
```

It lists what a run cannot do in this repository (configuration, agents, git, workflows, gates, AI hosts, uncommitted changes, dependencies, environment, remote) and the fix for each.

## metator: command not found

`bun link` linked `metator` into Bun's global bin folder, but that folder is not on your `PATH`. It happens in containers and when Bun came from npm or Homebrew. Find the folder and put it on your `PATH` in your shell profile:

```bash
bun pm bin -g                          # where the link is
export PATH="$(bun pm bin -g):$PATH"   # add this line to ~/.bashrc or ~/.zshrc
metator version
```

An alias is not enough on its own: the hooks and agents call `metator` from their own shells. Without the folder on `PATH`, set `hosts.metatorCommand` as [Install](../guide/install.md#from-a-checkout-for-developers-of-metatorai) shows.

## BIN_NOT_FOUND: ast-grep is not installed

MetatorAI runs the tools installed in your repository. Install the missing one as a development dependency.

::: code-group

```bash [npm]
npm install --save-dev @ast-grep/cli
```

```bash [pnpm]
pnpm add --save-dev @ast-grep/cli
pnpm approve-builds        # allow its install script, which downloads the binary
```

```bash [yarn]
yarn add --dev @ast-grep/cli
```

```bash [bun]
bun add --dev @ast-grep/cli
# add "@ast-grep/cli" to "trustedDependencies" in package.json, then:
bun install
```

:::

The same error for `biome` or `tsc` has the same fix with that package.

## A tsconfig extends a config that is not installed

The warning reads `<tsconfig> extends a config that is not installed; its own paths are used as aliases`. A tsconfig that extends a package needs that package in `node_modules`. Until then the import graph is approximate: aliases defined only in the extended config are missing. Install your dependencies and build the index again:

```bash
metator index build
```

## A file does not match its schema

The message names the kind, the version and the field, for example `does not match RuleSet v1: rules.0.rationale: ...`. Here `rules.0.rationale` is the `rationale` of the first rule. Print the schema to see every field:

```bash
metator rules schema
```

[Documents and schemas](./documents.md#print-a-schema) lists the schema command of each kind.

## schemaVersion is newer than supported

The file was written by a newer MetatorAI than the one you run. Upgrade MetatorAI. Older files need nothing: they are upgraded when read.

## sgconfig.yml not found

`metator rules scaffold` writes an ast-grep rule into the directories your `sgconfig.yml` lists. Create the file in the repository root:

```yaml
ruleDirs:
  - rules/ast-grep
testConfigs:
  - testDir: rules/ast-grep-tests
```

## The import index is stale

A command exits with code 65 and `STALE_INDEX`. Build the index:

```bash
metator index build
```

Only changed files are parsed again.

## A run is still active

`metator run close` fails with `run <id> is still active at stage <stage>`. It does not close an active run without being told to. Finish the run, or abort it with a reason:

```bash
metator run close --aborted --reason "scope changed"
```

## A run cannot be read

`metator run list`, `metator status`, `metator inbox` and `metator doctor` warn that `run <id> cannot be read and is left out`, and name the run's `state.json`. The file is cut short or was edited by hand. The other runs are listed as usual. The desktop app says the same at the bottom of the sidebar (**N runs cannot be read**), with the file of each. Restore the file from git or a backup, or delete the run's directory `.metator/runs/<id>/` to drop the run.

## A task cannot be read

`metator issue list` and `metator intake scan` warn that `issue <id> cannot be read and is left out`, and name its file in `.metator/issues/`. The file is cut short or was edited by hand. The other tasks are listed and scanned as usual, and a new task never takes its id. Restore the file from git or a backup, or delete it to drop the task.

## A file is locked

A command fails with `<file> is locked by process <pid>`. Another MetatorAI process was changing that file for more than two minutes. Run the command again when that process has finished. If no MetatorAI process runs, delete the `<file>.lock` the hint names.

## A run stopped and nothing happens

```bash
metator run status       # the stage and what it expects
metator inbox            # questions that wait for you
metator run continue     # pick a run that waits or stopped, and drive it again
```

If the process that drove the run died (a restart, a closed terminal), `metator run revive` starts every such run again at the stage it stood.

## A run is escalated

`metator run continue` answers `no active run to continue`, or `metator run drive` answers `run <id> escalated at <stage>: <reason>`. The run used up its tries at that stage and waits for you. Remove the cause, then resume it and drive it on:

```bash
metator run status --run <id>                      # the stage, the reason, the commands
metator run resume --run <id> --by alice --drive
```

To give it up: `metator run close --run <id> --aborted --reason "<why>"`. In the app, the run's card on Home has **Resume** and **Close run…**.

## A run cannot start here

`metator run new` fails with `a run cannot start here` when the directory is not a git repository, and with `--worktree` when the repository has no commit. The hint names the command. With `--worktree` it also fails with `the run would start without your changes` when tracked files have uncommitted changes: commit them, stash them, or pass `--allow-dirty` (in the app: **Start from the last commit**).

## A precondition does not hold

`metator run new` fails with `precondition <name> does not hold` when the workflow requires something the checkout does not meet. The hint names the fix.

| Message starts with | Fix |
|---|---|
| `precondition clean-tree does not hold` | commit or stash your changes, or pass `--allow-dirty` |
| `precondition branch-ok does not hold` | `git switch -c <branch>`, or start the run with `--worktree` |
| `precondition tests-green does not hold` | `metator gate quick`, fix the failing steps, start again |
| `the workflow requires ..., which nothing can check` | `metator setup` updates the installed workflows; in your own workflow, remove the line |

`metator doctor --gates` tells you whether the quick gate is green before you start. [Full runs](../use/runs.md#what-must-hold-before-a-run-starts) lists the preconditions.

## The AI host cannot start

`metator run drive --host copilot` fails with `AI host copilot cannot start here` when the Copilot CLI is not installed. Install it, or drive with a host the hint lists. `metator doctor` shows the same under `host`.

## A commit or a push asks, or is denied

A `git commit`, `push`, `merge` or `rebase` an agent runs needs your consent (`guard.commands.ask`). In a session with a terminal, the host shows its approval prompt and Home shows it as a card: say **Yes** there, or tell the chat "commit it". In a session without a terminal (`metator run drive`), nobody can be asked, so it is denied until the run's approval covers it:

```bash
metator run approve push --by alice      # also what approving the delivery does
```

A merge (`gh pr merge`, `glab mr merge`, a merge MCP tool, a push straight to `main` or `master`) always asks, also after an approved push: say "merge it", click **Yes**, or in a run `metator run approve merge --by alice`.

Inside a run, `gh pr create`, `glab mr create` and code host MCP tools that write need the same `push` approval, and `gh pr comment` or `gh pr review` need `metator run approve comment --by alice`. See [Approvals and consent](../use/approvals.md#commit-and-push).

## A command never runs here

The hook answers `` `git reset --hard` never runs here (guard.commands.never: …) ``. The command is on `guard.commands.never`, and no agent runs it. If you want it, run it yourself in a terminal. To change the list, edit `guard.commands` in `metator.config.yml` ([Configuration](./configuration.md#guard)).

## This commit holds debug changes

A `git commit` stops with `this commit holds debug changes: src/price.ts`. A change recorded with `metator scratch` (a debug edit) is still in those files. Take it out (`metator scratch drop --all`, or **Remove debug changes** in the app), or say "commit anyway". A record whose lines changed since cannot be taken out as recorded: remove its lines by hand, then `metator scratch forget --id <id>` ([Quick and debug changes](../use/quick.md#debug-changes)).

## A quick change is refused

`metator quick start` answers one of:

| Message | Fix |
|---|---|
| `not quick: size (6 files (limit 5)); …` | the change trips an escalator: use the full workflow, or keep it quick in your own words with `--override "<sentence>"` |
| `not quick, and this cannot be overridden: it reaches another repository` | a change across repositories is a [system plan](../many/plans.md) |
| `dirty: pass --here or --worktree` | the checkout has uncommitted changes: `--here` takes them into the change, `--worktree` works from the last commit |
| `the quick gate has no steps: …` | the quick run checks its change with `metator gate quick`: add steps under `gates.quick` in `metator.config.yml` ([Gates and CI](../repo/gates-ci.md)) |

## A session in the sandbox cannot start or cannot reach something

With `sandbox.enabled`, every session MetatorAI starts runs in the operating system's sandbox ([Hold sessions in a sandbox](../repo/hooks.md#hold-sessions-in-a-sandbox)).

| What you see | Fix |
|---|---|
| The pane ends at once with `Sandbox dependencies not available: ripgrep (rg) not found` (or `bwrap`, `socat`) | install `bubblewrap`, `socat` and `ripgrep`; `metator doctor` lists what is missing under `isolation` |
| `metator doctor` says native Windows has no sandbox | run MetatorAI and the host inside WSL2, or turn the sandbox off |
| A command in the session cannot reach a host (`Connection blocked by network allowlist`, a `403` from the proxy) | add the host: `metator config set sandbox.allowedDomains "registry.npmjs.org" --scope repo`; the next session has it |
| A command cannot write a file outside the repository (`Read-only file system`) | add the path to `sandbox.allowWrite` |
| `git push` over SSH fails to read the key | `~/.ssh` is in `sandbox.denyRead`: push through an SSH agent, or take it out of the list |
| The session's sandbox does not start inside Claude Code's own sandbox | an earlier `metator generate --hooks` wrote a `sandbox` block into `.claude/settings.json`: remove it |
| A `claude` or `copilot` you started yourself reads files the sandbox denies | it runs outside MetatorAI, without the sandbox: start the session from MetatorAI |

## The app says no daemon

The top bar reads **no daemon** and the main area shows `metator serve`, the address and **Retry**. Start the daemon in your repository or folder (`metator serve`). If it listens on another port, type its address in the field and click **Retry** ([Get the desktop app](../guide/desktop-app.md#connect-it-to-the-daemon)).

`metator serve` itself fails with `a daemon already serves <dir>: <url> (pid <pid>)` when one runs there already, also when a folder's daemon serves the repository: use that one, or stop it first.

## No chat opens

**+ New chat** says that no AI host is installed and names the programs the daemon looked for. Install Claude Code (`claude`) or GitHub Copilot CLI (`copilot`), log in once in a terminal, and click **+ New chat** again; the daemon needs no restart. A chat whose terminal ends at once with **Ended with code …** usually means the host is not logged in. [Copilot and Claude Code](../guide/hosts.md#which-host-runs-what) says which host the daemon picks.

## A command works on one repository, and this is a folder

In a folder of repositories, a command that works on one repository stops with `` `metator run status` works on one repository, and ~/work is a folder of 3 ``. Run it inside a repository, or with `-C <repository>`. In the folder itself, `status`, `inbox`, `repos`, `ask`, `report`, `serve`, `supervise` and `system discover` cover every repository ([Folder of repositories](../many/index.md#what-runs-in-the-folder)).

## An edit is denied as outside plan-scope.json

During a run, agents may edit only the files the approved plan lists. If the task needs another file, the plan must change: the agent goes back to planning, or you answer its question about the scope.

## The repository has no commit yet

Right after `git init` there is nothing to branch from, so `metator doctor` reports `commits` as `fail`, and `metator worktree new` and `metator run new --worktree` stop. Make the first commit:

```bash
git commit --allow-empty -m init
```

## Base ref shares no history with HEAD: this clone is shallow

The base ref exists, but the commits between it and `HEAD` were not fetched, as in a CI checkout of depth 1. Fetch the history with `git fetch --unshallow`, or set `fetch-depth: 0` on `actions/checkout` ([Gates and CI](../repo/gates-ci.md#your-own-job)).

## A --check command fails in CI

`metator cards build --check` or `metator generate --check` fails when the code or the agent definitions changed and the generated files did not. Regenerate and commit:

```bash
metator cards build
metator generate
metator rules adapters
```

## A citation is stale

`metator memory validate` or `metator docs drift` reports a quote that is no longer in the code. If the code only moved, let the command update the line numbers:

```bash
metator memory validate --fix
metator docs drift --fix
```

If the code changed, the statement is no longer true. Update the statement or the code.

## Find the state of a run

```bash
metator run list             # every run, newest first
metator run status           # the latest run: stage, what it expects, recent history
ls .metator/runs/<id>/       # state.json, log.md, artifacts
```
