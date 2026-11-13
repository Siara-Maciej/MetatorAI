# Output and exit codes

Every `metator` command prints one JSON object and exits with a stable code. This page describes both, so you can call the CLI from a script or from CI. The commands themselves are in the [Command reference](./commands.md).

## Output

A command prints exactly one JSON object on stdout. There are no colors and no banners.

On success:

```json
{"ok":true,"data":{ ... },"warnings":["notes that do not fail the command"]}
```

`warnings` is present only when there is something to say.

On failure:

```json
{"ok":false,"error":{"code":"USAGE","message":"unknown command 'nosuch'","hint":"Run `metator help` to list commands and options."}}
```

| Field | Meaning |
|---|---|
| `code` | a stable error code (see [Error codes](#error-codes)); branch on it, never on the message |
| `message` | one line for a person |
| `hint` | the next step, when there is one |
| `details` | the full report, for example every violation or every failing step |

Two kinds of command do not follow this. The hook commands (`metator guard ...`) answer in the host's [hooks protocol](./hooks.md). `metator attach` takes over the terminal.

## At a terminal

Stdout is always the one JSON line. When you type a command at a terminal, some commands also write text for you to read on **stderr**: `metator status`, `inbox`, `run status`, `doctor`, `help` and any `--help`. A pipe or a script sees the same JSON line as before, because the text is not on stdout.

```bash
metator status            # text on stderr, the JSON line on stdout
metator status --json     # the JSON line alone, also at a terminal
metator status | jq .data # a pipe gets the JSON line; nothing is rendered
```

`--json` works before or after the command.

## Help

`metator help` lists every command. `metator help --verbs` lists the ones a person types, grouped by what you want to do. `metator help --for person|agent|hook|ci` lists the commands of one audience: the ones you type, the ones an agent of a run calls, the hooks a host calls, and the checks a CI job runs. `metator <command> --help` (or `-h`) describes one command. A command group typed alone, such as `metator repos`, prints the group's help.

```bash
metator run answer --help
```

```json
{"ok":true,"data":{"name":"run answer","summary":"Record the answer to a question; the run continues when a drive is waiting for it (with none, `metator run continue` starts one)",
 "usage":"metator run answer [options] <question>",
 "options":[{"flags":"--run <id>","description":"run id (default: latest)"}, ...]}}
```

## Exit codes

| Exit code | When |
|---|---|
| `0` | success |
| `1` | a check failed, something was not found, or a document is invalid |
| `64` | usage error: unknown command, missing or invalid argument |
| `65` | the import index is stale; run `metator index build` |

Hook commands always exit `0`.

## Error codes

| Code | Typical cause | Exit code |
|---|---|---|
| `USAGE` | wrong arguments, or an event the current stage does not accept | 64 |
| `STALE_INDEX` | the import index is older than the files | 65 |
| `NOT_FOUND` | no such run, pane, rule, file or map | 1 |
| `INVALID_CONFIG` | `metator.config.yml`, a workflow, a rule set or the system map does not match its schema, or a gate has no steps | 1 |
| `INVALID_ARTIFACT` | a run artifact or another document does not match its schema | 1 |
| `CHECK_FAILED` | a check ran and found problems (rules, gates, lint of plans, workflows, docs) | 1 |
| `COMMAND_FAILED` | a tool MetatorAI ran failed in a way it could not report | 1 |
| `BIN_NOT_FOUND` | a tool such as ast-grep is not installed in the repository | 1 |
| `TRANSITION_DENIED` | a state change the workflow does not allow, or a run that has ended | 1 |
| `PARSE_FAILED` | a tool's output could not be parsed | 1 |
| `INTERNAL` | a bug in MetatorAI; please report it | 1 |

## Global option

`-C, --root <dir>` runs a command against another repository. Without it, MetatorAI uses the nearest ancestor directory that has `.git`.

```bash
metator -C ../billing run status
```

## Environment variables

| Variable | Effect |
|---|---|
| `METATOR_NOW` | pins the clock to an ISO time, for reproducible run ids and logs in tests |
| `METATOR_ROLE` | `coordinator` makes `metator guard pre-tool` treat the caller as a coordinator, which may not edit files |
| `METATOR_CONFIG_DIR` | the directory of your own options file (default: `$XDG_CONFIG_HOME/metator`, else `~/.config/metator`) |
| `METATOR_STATE_DIR` | the directory of state shared by every repository on the machine (default: `$XDG_STATE_HOME/metator`, else `~/.local/state/metator`) |
| `METATOR_COPILOT_BIN`, `METATOR_CLAUDE_BIN`, `METATOR_OPENCODE_BIN` | the binary MetatorAI starts for that host |
| `METATOR_DOCKER_BIN` | the Docker binary used for application environments |

## Read the output in a script

```bash
metator graph affected --base main | jq -r '.data.tests[]'          # the tests to run
metator rules check --base main | jq '.error.details.violations'    # every violation
metator gate full > /dev/null || echo "gate failed"                 # the exit code is enough
```
