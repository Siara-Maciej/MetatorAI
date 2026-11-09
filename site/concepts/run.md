# Run

A run is one task carried out as a state machine. It moves only through `metator run advance` and `metator run approve`, writes every transition to an append-only log, and leaves its artifacts on disk, so any session, CI job or AI host can pick it up where the last one stopped.

## Why it exists

A chat has no state an agent cannot talk itself out of. A run does: the current stage, the loops used, the approvals given and the artifacts produced are files, written only by the CLI. An agent that wants to skip a stage, loop forever or approve its own plan is refused by the state machine, not asked nicely.

## Where it lives

| File | What |
|---|---|
| `.metator/runs/<id>/state.json` | `RunRecord`: stage, loops, approvals, the live drive, parent and children; written only by `metator run` |
| `.metator/runs/<id>/log.md` | append-only audit trail: every transition, approval, checkpoint and close |
| `.metator/runs/<id>/activity.jsonl` | one event per line: stages, agents, tools, questions, answers and gates, written by the drive |
| `.metator/runs/<id>/*.json` | the stage artifacts: `analysis.json`, `plan.json`, `plan-scope.json`, `findings/`, `verdict.json` |
| `.metator/runs/latest` | a pointer to the run most recently touched |

## Commands

```bash
metator run init --workflow mt-feature --task "Add combined discount"   # a new run at the first stage
metator run status                                                      # stage, what it expects, recent history
metator run advance pass                                                # the stage is done
metator run advance fail --reason "gates: 2 tests red"                 # back to the stage the spec names, bounded
metator run approve plan-approval --by alice                           # a human gate
metator run handoff                                                     # handoff.md for a colleague
metator run close                                                       # summary.json with the final telemetry
```

In practice the agents call these; you drive by hand only to see the state machine work, or from [sessions](../work/sessions.md), where a run has a terminal.

## What enforces it

- `run advance` accepts only the events the current stage expects; a human gate accepts only `run approve`.
- A failure goes back to the stage the workflow names, at most as often as the loop limit allows; then the run is **escalated** to a person with the open problems.
- `guard session-start` puts `run status` into every new host session, and `guard precompact` writes a checkpoint before the host compacts its context, so nothing depends on chat memory.
- `run close` refuses to close an active run without `--aborted` and a reason.

## One example

```bash
$ metator run advance pass
{"ok":false,"error":{"code":"APPROVAL_REQUIRED",
 "message":"plan-approval is a human gate",
 "hint":"metator run approve plan-approval --by <name>"}}
```

## Related

- [Workflow](./workflow.md): the spec a run follows.
- [Gate and approvals](./gate.md): where a run waits.
- [Session](./session.md): the worktree and terminal a run works in.
- [Work: runs](../work/index.md): the life of a run, step by step.
