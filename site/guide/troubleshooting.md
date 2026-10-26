# Troubleshooting

Every error carries a `code`, a `message` and usually a `hint` with the next step. Start there.

## `BIN_NOT_FOUND: ast-grep is not installed`

The rule engine runs the binary installed in **your** repository.

```bash
bun add -d @ast-grep/cli
```

With Bun, also allow its install script, which downloads the binary:

```json
{ "trustedDependencies": ["@ast-grep/cli"] }
```

Then `bun install --force`. The same applies to other tools with install scripts.

## `does not match RuleSet v1: rules.0.rationale: ...`

A file does not match its schema. The message names the field (`rules.0.rationale` is the `rationale` of the first rule). Print the schema to see every field:

```bash
metator rules schema      # also: config schema, plan schema, workflow schema, system schema, ...
```

## `sgconfig.yml not found`

`metator rules scaffold` writes an ast-grep rule into the directories your `sgconfig.yml` lists. Create one:

```yaml
ruleDirs:
  - rules/ast-grep
testConfigs:
  - testDir: rules/ast-grep-tests
```

## The import index is stale (exit code 65)

Some graph commands need a fresh index:

```bash
metator index build
```

The index is incremental: only changed files are parsed again.

## `run ... is still active at stage build`

`metator run close` never closes an active run silently. Either finish it with `metator run advance ...`, or abort it with a reason:

```bash
metator run close --aborted --reason "scope changed"
```

## A push is denied by the hook

That is the point: `guard pre-tool` denies `git push`, `gh pr create` and similar until a human approves the action for the active run.

```bash
metator run approve push --by alice
```

## `cards build --check` or `generate --check` fails in CI

Someone changed the code or the canon without regenerating. Run the generator and commit the result:

```bash
metator cards build
metator generate
metator rules adapters
```

## A citation is stale

`memory validate` or `docs drift` reports a quote that is no longer in the code. If the code only moved:

```bash
metator memory validate --fix
metator docs drift --fix
```

If the code changed, the knowledge is no longer true: update the statement, or the code.

## Where is the state of my run?

```bash
metator run list             # every run, newest first
metator run status           # the latest run: stage, what it expects, recent history
ls .metator/runs/<id>/       # state.json, log.md, artifacts
```
