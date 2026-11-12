# Gates and approvals

A run cannot pass some stages on an agent's word. A gate is a check that a tool or a second agent decides. An approval is a stage that waits for a named person. This page lists both, shows how to approve or reject, and explains how the autonomy level changes which approvals ask you.

## Kinds of gates

A workflow has two kinds of gate and the approval:

| Kind | Opened by | Examples |
|---|---|---|
| Check | a command that exits 0 | `metator plan lint`, `metator gate full` |
| Critic | a second agent whose answer ends with `VERDICT: PASS`. A missing verdict counts as a fail. | the plan critic (`mt-plan-critic`), the review judge (`mt-judge`) |
| Approval | a named person | plan approval, delivery |

A workflow marks each one in its spec: `gate.script` for a check, `gate.llm` for a critic, `hitl: true` for an approval.

When a check or a critic fails, the run goes back to the stage the workflow names and tries again, up to the workflow's loop limit. Then it is escalated to you (see [Runs and workflows](./runs.md#how-a-run-moves)).

## The quality gates

`metator gate` runs your repository's own scripts, as listed under `gates` in `metator.config.yml`:

```bash
metator gate quick --base main     # the short list, scoped to files changed against main
metator gate full                  # every step: lint, typecheck, tests
```

The report is saved to `.metator/gates/<gate>.json`. Agents and CI run the same command. [Gates and CI](../repo/gates-ci.md) explains how to configure the steps.

## Approve or reject

When a run waits for you, `metator run status` shows `"expects":["APPROVE","FAIL","ABORT"]`. Read what the stage before it produced (for a plan, `plan.json` in the run's directory), then decide:

```bash
metator run approve plan-approval --by alice                         # go on
metator run advance fail --reason "step 3 has no test"               # send it back with the reason
metator run advance abort --reason "not needed any more"             # end the run
```

An approval is recorded in `state.json` and `log.md` with the name and the time. An agent that sends `pass` at this stage gets an error:

```json
{"ok":false,"error":{"code":"TRANSITION_DENIED",
 "message":"Stage \"plan-approval\" (active) does not accept PASS",
 "hint":"This approval needs a person's decision: APPROVE, FAIL, ABORT."}}
```

When a run is driven from the terminal, the same approvals arrive as questions. Answer them from one queue with `metator inbox` and `metator run answer` (see [Answer questions](../use/inbox.md)).

## Push and comments

Two actions leave your machine: pushing (which includes creating or merging a pull request) and commenting on a pull request. The pre-tool hook denies both until the run holds the matching approval:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"push needs the user's approval: show the report and options, then `metator run approve push --by <user>`."}}
```

In `mt-feature`, `mt-bugfix` and `mt-refactor`, approving the `delivery` stage grants the push, so you are asked once:

```bash
metator run approve delivery --by alice
```

In `mt-pr-review`, approving the `approval` stage grants the comments in the same way.

You can also grant an action directly with `metator run approve push --by alice` or `metator run approve comment --by alice`. A workflow lists the external actions its runs may take (`permissions.external`); an action it does not list is refused. `mt-self-review` lists none, so its runs can be granted neither.

This protection needs the hooks. Install them with `metator setup --hooks` or `metator generate --hooks` (see [Hooks and guardrails](../repo/hooks.md)).

## Autonomy

A run has an autonomy level. It decides which approval stages ask you.

| Level | Effect |
|---|---|
| `L0` (default) | every approval stage asks you |
| `L1` | stages the workflow marks `skipAt: [L1]` are passed by the level. In the shipped workflows that is the plan approval. |
| `L2` | headless, for `mt-pr-review` in CI. Its approval stage is marked `skipAt: [L2]`. |

Set the level when you start the run, or switch an `L0` run to `L1` while you approve:

```bash
metator run init --workflow mt-feature --task "Bump the retry limit" --autonomy L1
metator run approve plan-approval --by alice --choice autopilot
```

A stage passed by the level is logged that way, so the log always tells a person's decision from an automatic one:

```text
- 2026-11-11T01:41:08.932Z · plan-gate · PASS → plan-approval
- 2026-11-11T01:41:08.932Z · plan-approval · skipped at L1 → build
```

A stage marked `neverSkip` asks a person at every level. In the shipped workflows that includes every `delivery` stage, so no level pushes on its own. A workflow also lists the levels it supports, and `metator run init` refuses a level that is not on the list. `mt-review-response` supports only `L0`. Without `--autonomy` a run starts at `L0`, or at the first level the workflow lists when it does not list `L0`.

## Answers that repeat

A level covers whole stages. For one kind of question that you always answer the same way, add `--always` to the answer:

```bash
metator run answer q004 --choice Deny --by alice --always
```

This writes an answer policy to `metator/answer-policies.yml`, a file you commit and review. `metator policy list` shows the policies and `metator policy rm <id>` removes one.

A policy cannot do everything a person can. It may deny a tool permission but never allow one. It cannot answer a decision that cannot be taken back, such as a push. It cannot reject, because a rejection needs your reason.
