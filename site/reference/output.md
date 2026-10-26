# Output and exit codes

## The envelope

Every command prints exactly one JSON object on stdout, and nothing else (no colors, no banners).

Success:

```json
{"ok":true,"data":{ ... },"warnings":["optional notes that do not fail the command"]}
```

Failure:

```json
{"ok":false,"error":{"code":"CHECK_FAILED","message":"1 rule violation(s)",
 "hint":"Fix the code; `metator rules show <id>` explains a canon rule.","details":{ ... }}}
```

| Field | Meaning |
|---|---|
| `code` | stable error code (below); branch on it, not on the message |
| `message` | one line for a human |
| `hint` | the next step, when there is one |
| `details` | the full report, for example every violation or every failing step |

Hook commands (`metator guard ...`) are the exception: they print the answer the host expects, or nothing.

## Exit codes

| Exit code | When |
|---|---|
| `0` | success |
| `1` | a check failed, something was not found, or a document is invalid |
| `64` | usage error: unknown command, missing or invalid argument |
| `65` | the import index is stale; run `metator index build` |

## Error codes

| Code | Typical cause |
|---|---|
| `USAGE` | wrong arguments, an event the current stage does not accept |
| `NOT_FOUND` | no such run, rule, file or map |
| `INVALID_CONFIG` | `metator.config.yml`, a workflow, a rule set or the system map does not match its schema |
| `INVALID_ARTIFACT` | a run artifact or another document does not match its schema |
| `CHECK_FAILED` | a check ran and found problems (rules, gates, lint of plans, workflows, docs) |
| `COMMAND_FAILED` | a tool MetatorAI ran failed in a way it could not report |
| `BIN_NOT_FOUND` | a tool such as ast-grep is not installed in the repository |
| `STALE_INDEX` | the import index is older than the files |
| `TRANSITION_DENIED` | a state change the workflow does not allow |
| `BINDING_MISSING` | a capability has no provider configured |
| `PARSE_FAILED` | a tool's output could not be parsed |
| `INTERNAL` | a bug in MetatorAI; please report it |

## Reading the output in scripts

```bash
metator graph affected --base main | jq -r '.data.tests[]'          # the tests to run
metator rules check --base main | jq '.error.details.violations'    # every violation
```
