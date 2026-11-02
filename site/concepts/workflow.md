# Workflow

A workflow is the YAML spec a run follows: its stages, who owns each one (an agent, a skill or a script), which artifact it must produce, which gate closes it, how often a failure may loop back, and which gates an autonomy level may pass without a person.

## Why it exists

The alternative is a long prompt that describes a process and hopes the model follows it. A spec is read by `metator run`, not by the model: the stage order, the loop limits and the human gates hold whether or not the agent remembers them. The same spec drives a run in Copilot Chat, in Claude Code, from the terminal and in CI.

## Where it lives

| File | What |
|---|---|
| `.github/metator/workflows/<id>.yml` | the spec, a `Workflow` document; six are shipped: `mt-feature` (W1), `mt-bugfix` (W2), `mt-refactor` (W3), `mt-pr-review` (W4), `mt-self-review` (W5), `mt-system-change` (W13) |
| `metator/install.lock.json` | which shipped specs you have and whether you changed them, so `metator agents update` never overwrites your edits |

## Commands

```bash
metator workflow schema          # the JSON Schema of a workflow
metator workflow validate        # every spec against the schema
metator workflow lint            # every spec against the 16-section anatomy
```

`workflow lint` requires every workflow to answer: **start** (entry, input contract, preconditions), **stages** (owners, artifacts, gates, parallelism, loops), **control** (escalation, autonomy, permissions), **finish** (definition of done, recovery, resume) and **reporting** (telemetry, final report). It also checks that every owner and critic is a real agent or skill.

## What enforces it

- A run cannot start on a spec that does not validate.
- Every `onFail` must name the stage to go back to and the loop limit it counts against; a stage without an owner or an artifact fails lint.
- `run init` refuses an `--input` the spec does not declare, and a stage whose input is missing stops the run with the input it needs.
- The shipped specs are installed from the package and recorded in a lock; `agents update` keeps your changes and warns on conflicts.

## One example

Here is the shipped bug-fix workflow, drawn from its spec. The token moves the way `metator run advance` does.

<WorkflowDiagram id="mt-bugfix" />

## Related

- [Run](./run.md): one execution of a workflow.
- [Gate and approvals](./gate.md): what `hitl`, `skipAt` and `neverSkip` mean.
- [Work: Feature](../work/feature.md), [Bug fix](../work/bugfix.md), [Refactor](../work/refactor.md), [Review](../work/review.md): the shipped workflows, stage by stage.
