# Gate and approvals

A gate is a point in a run that only evidence or a person can open. A deterministic gate runs a check and reads its report. A human gate accepts nothing but `metator run approve <gate> --by <name>`; an agent's own "PASS" is rejected.

## Why it exists

A model can be asked to follow a rule; it cannot be trusted to remember it at the moment it matters. A gate moves the rule out of the prompt: the run does not advance until the artifact validates, the check passes, or a named person approves. Every approval is recorded with who gave it and when.

## Where it lives

| File | What |
|---|---|
| `.github/metator/workflows/*.yml` | which stages are gates: `hitl: true`, `skipAt`, `neverSkip`, `gate.script`, `gate.llm`, loop limits |
| `.metator/runs/<id>/state.json` | the approvals, with who and when; written only by `metator run` |
| `.metator/gates/<gate>.json` | the report of a deterministic gate (`gate quick`, `gate full`), cited by the review |
| `.metator/runs/<id>/log.md` | every approval and every loop back, in order |

## Kinds of gates

| Kind | Opened by | Example |
|---|---|---|
| Deterministic | a check that exits 0 and leaves a report | `plan lint`, `gate full`, `rules check`, `contract diff` |
| Critic | an agent on another model whose verdict ends with `VERDICT: PASS`; a missing verdict is a fail | the plan critic, the judge |
| Human | `metator run approve` by a named person | plan approval, push, PR comments |

## Commands

```bash
metator gate quick --base main             # the repository's own checks on the branch's files
metator gate full                          # every configured check, one report in .metator/gates/
metator plan lint                          # every step names a file, tests first, an exemplar
metator run approve plan-approval --by alice
metator run approve push --by alice        # external actions are separate approvals
metator run advance fail --reason "gates: 2 tests red"   # a bounded loop back
```

## What enforces it

- The run state machine accepts at a human gate only an approval, never an agent's event.
- `guard pre-tool` denies `git push`, PR creation and PR comments until the matching approval exists in the run.
- A loop limit reached escalates the run to a person; it never retries forever.
- Autonomy levels change which gates ask you ([Autonomy and autopilot](../work/autonomy.md)); push and comments ask at every level, and a gate marked `neverSkip` cannot be automated away.
- Planned with the next step of sessions: an approval given in the host's chat will count only while a person is attached as the driver, and will be recorded through the same `run approve`.

## One example

```bash
$ echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"push needs the user's approval: show the report and options, then `metator run approve push --by <user>`."}}
```

After `metator run approve push --by alice` the same call answers `allow`.

## Related

- [Run](./run.md): the state machine the gates live in.
- [Autonomy and autopilot](../work/autonomy.md): which gates L1 may pass without you.
- [Inbox and decisions](../work/inbox.md): answering every gate from one queue.
- [Quality gates and CI](../knowledge/gates-ci.md): configuring the deterministic gates.
