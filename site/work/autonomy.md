# Autonomy and autopilot

A run has an autonomy level. It decides which human gates ask you and which the level may pass on your behalf, logged. Push and PR comments ask a person at every level, and a gate marked `neverSkip` in the workflow cannot be automated away.

| Level | Use it when | What changes |
|---|---|---|
| `L0` (default) | you want to see every gate | every human gate asks you |
| `L1` (autopilot) | routine work you trust | gates with `skipAt: [L1]` (for example the plan approval) are approved by the level and logged as such |
| `L2` | headless review in CI | no interactive gates; only confirmed blockers are published |

```bash
metator run init --workflow mt-feature --task "Bump retry limit" --autonomy L1
metator run approve plan-approval --by alice --choice autopilot   # switch an L0 run to L1 at a gate
```

## What the log shows

```text
- 2026-10-26T22:25:16Z · setup · PASS → intake
- 2026-10-26T22:25:25Z · plan-approval · APPROVE · by maciej · choice autopilot → build
- 2026-10-26T22:25:25Z · autopilot · autonomy L1
- 2026-10-26T22:25:25Z · approved push · by maciej
```

An approval by the level is written as such, so an audit can always tell a person's decision from autopilot.

## Policies learned from your answers

Permissions you grant the same way again and again can become policies ([Inbox and decisions](./inbox.md#permissions-that-repeat)). A policy is narrower than a level: it answers one kind of question, in one way, and is recorded in `metator.config.yml` where it can be reviewed and removed.

## Next

- [Gate and approvals](../concepts/gate.md).
- [Review a PR](./review.md#publishing): the headless level in CI.
