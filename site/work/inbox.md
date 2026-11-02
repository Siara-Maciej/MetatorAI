# Inbox and decisions

::: info Planned
The decision inbox is specified and designed; it is the next thing to land in `metator ui` and in the desktop application. The commands and fields below are not in the CLI yet. Today, questions are answered with `metator run questions` and `metator run answer`, or with `a` in [`metator ui`](./sessions.md#the-session-screen).
:::

**What for:** with several sessions going at once, every question, permission and gate that waits for you lands in one queue, sorted by what it costs to leave it waiting. Each item is a decision card that carries enough to answer it without opening the session: what the agent did since you last looked, what it proposes with evidence, what each option does, and which one is recommended. The goal is an empty inbox.

## A decision card

| Part | What it holds | Where it comes from |
|---|---|---|
| Header | question id, gate or permission, run, repository, workflow, autonomy, host | `state.json` |
| Reversible | whether the decision can be undone, and how | the kind of gate and stage |
| Blast radius | files, packages and dependents the decision touches | `graph affected`, `plan-scope.json` |
| Waiting | how long, and what it costs: an idle agent, ports held, a deploy wave blocked | the run's worktree and the system plan |
| Since you left | what happened since your last answer | `log.md`, `activity.jsonl` |
| Proposal | what the agent proposes, each step with its file and exemplar `file:line` | `plan.json`, `findings/`, `verdict.json` |
| Evidence | the checks that already ran: `plan lint ✓`, rules in scope, `graph diff` | `.metator/gates/`, lint reports |
| Options | what each option does next: build starts, loops back (and which loop), autopilot takes over | the workflow spec |
| Recommended | one option, chosen by a deterministic rule (for example: lint passed and the critic found nothing blocking) | never by a model |

Nothing on the card is written by a model. It is assembled from the run's files when the question is asked, so it is as true as the files are. The card is the second version of the `Question` document; a first-version question is shown with the fields it has.

## Answering

An answer is carried out by the run's drive: when none is running, the inbox starts it again with the host the run used, so you never continue by hand after answering. Approving with the autopilot choice switches that run to `L1` ([Autonomy and autopilot](./autonomy.md)).

## Permissions that repeat

A permission you keep granting ("run the read-only tests") is a policy candidate. The card shows how often you answered it and offers **Make it a policy**; the policy is recorded in `metator.config.yml` and the question stops coming. A permission that must always ask (installing a dependency, which needs an ADR) says so and never becomes a policy.

## Escalations are not questions

A run that reached its loop limit or whose agent is blocked is **escalated**. The inbox lists it separately, with a link to its briefing and its terminal, because what it needs from you is work, not a yes or a no.

## Attention budget

The header shows how many sessions wait for you against a limit you set. Above the limit, new questions queue behind the open ones and new runs start with a warning.

## Next

- [Sessions and terminals](./sessions.md): what exists today, and what comes with the inbox.
- [Gate and approvals](../concepts/gate.md): what an approval is and what records it.
