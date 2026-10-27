# Drive a run from the CLI

**What for:** in Copilot Chat or Claude Code, a coordinator agent walks the workflow and you answer in the chat. With `metator run drive`, MetatorAI itself walks the stages: it starts each worker through your AI host, runs the scripts and gates, and stops at every decision that belongs to a person. You answer from any terminal, and the run can go on in the background while you work on something else.

Both modes use the same workflow spec, the same agents and hooks, and the same run state. A run started in one mode can finish in the other.

## Start, drive, answer

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run drive --host claude --detach       # or --host copilot; default: first of hosts.targets
```

```json
{"runId":"20261027-mt-feature-add-combined-discount","detached":true,"pid":48211,"host":"claude","alive":true}
```

The drive now walks the stages in the run's worktree. When it needs you, it writes a question and waits:

```bash
metator run questions
```

```json
{"questions":[{"id":"q001","stage":"plan-approval","source":"gate",
  "prompt":"The human approves the plan: approve to continue",
  "options":[{"label":"Approve"},{"label":"Reject"},{"label":"Other"}]}]}
```

```bash
metator run answer q001 --choice Approve --by alice
metator run answer q002 --choice Reject --text "split step 3 into two" --by alice
metator run answer q003 --text "use EUR, never mix currencies" --by alice   # Other: your own words
```

**Questions come from three places:**

| `source` | When | What your answer does |
|---|---|---|
| `gate` | a HITL stage (plan approval, push, comments) | Approve continues; Reject sends the run back with your reason |
| `agent` | a worker asks (`AskUserQuestion` in Claude Code, `STATUS: blocked: …` from any host) | the answer goes back to the same agent session, which continues |
| `permission` | a worker wants a tool that is not pre-approved (Claude Code) | Allow runs the call; Deny refuses it, with your reason |

## Watch the run

```bash
metator run activity --tail 8
```

```json
{"driver":{"pid":48211,"host":"claude","alive":true},"entries":[
  {"type":"stage","stage":"build","text":"Tests RED then GREEN, edits only inside the plan scope"},
  {"type":"agent","stage":"build","agent":"mt-test-author","text":"mt-test-author started"},
  {"type":"tool","stage":"build","agent":"mt-test-author","text":"Write packages/billing/test/discount.test.ts"},
  {"type":"advance","stage":"build","text":"PASS"},
  {"type":"stage","stage":"gates","text":"Lint, typecheck, rules, affected tests, graph and API diff"},
  {"type":"tool","stage":"gates","text":"$ metator gate full"}]}
```

`.metator/runs/<id>/activity.jsonl` holds every entry, one versioned JSON object per line. It is the record the live view and the session UI read.

## Stop and continue

```bash
metator run stop                         # the drive process ends; the run stays at its stage
metator run drive --host claude --detach  # continue later: the same open question is not asked twice
```

A run has at most one live driver. A second `run drive` is refused while the first is alive, and a driver that died does not block a new one.

## How a stage is carried

1. **A HITL stage** becomes a question (Approve, Reject, Other). Skipped stages (`skipAt` your autonomy level) never ask.
2. **Scripts** (`owner: "script:…"`) run with your `hosts.metatorCommand`. `{runDir}` in the command is the run directory, and `METATOR_RUN` and `METATOR_RUN_DIR` are set.
3. **Agents** run in order; `parallel` workers run together. Each gets one message: the stage, the task, where to write its artifacts, the skills it may use and, after a failed gate, why it failed. It must finish with `STATUS: done` or `STATUS: blocked: <question>`.
4. **Artifacts** listed in `produces` must exist in the run directory, or the stage fails.
5. **Gates:** `gate.script` must exit 0; the critic of `gate.llm` must end with `VERDICT: PASS`. A missing verdict is a FAIL, never a silent pass.
6. **Transitions** go through `run advance` and `run approve`. Loops, limits and escalation are the workflow's, exactly as in interactive mode.

## Try it without a model

The `scenario` host plays a script instead of calling a model. Use it to try a workflow, demo it, or test a workflow you wrote:

```yaml
# scenario.yml
kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - say: Planning the change
      - write: { path: "{runDir}/plan.md", text: "# Plan\n" }
      - say: "STATUS: done"
  mt-implementer:
    - - ask: { question: "Round half up or half even?", options: [half-up, half-even] }
      - write: { path: src/discount.ts, text: "export const discount = 1;\n" }
      - say: "STATUS: done"
```

```bash
METATOR_AGENT_SCENARIO=scenario.yml metator run drive --host scenario --detach
```

Each start of an agent plays its next entry (the last one repeats), so a loop that comes back needs its own entry.
