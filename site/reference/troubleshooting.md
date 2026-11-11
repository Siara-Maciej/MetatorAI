# Troubleshooting

Find an error here by its message and get the fix. Every error has a `code` and a `message`, and usually a `hint` that names the next step. Read the hint first.

For a check of the whole setup, run:

```bash
metator doctor
```

It lists what a run cannot do in this repository (configuration, agents, workflows, gates, dependencies, environment, remote) and the fix for each.

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

## A run stopped and nothing happens

```bash
metator run status       # the stage and what it expects
metator inbox            # questions that wait for you
metator run continue     # pick a run that waits or stopped, and drive it again
```

If the process that drove the run died (a restart, a closed terminal), `metator run revive` starts every such run again at the stage it stood.

## A push is denied by the hook

`metator guard pre-tool` denies `git push`, `gh pr create` and similar actions until a person approves them for the active run:

```bash
metator run approve push --by alice
```

Comments on pull requests and issues need `metator run approve comment --by alice`.

## An edit is denied as outside plan-scope.json

During a run, agents may edit only the files the approved plan lists. If the task needs another file, the plan must change: the agent goes back to planning, or you answer its question about the scope.

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
