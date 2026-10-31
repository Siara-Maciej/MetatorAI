# Drive a run from the CLI

**What for:** in Copilot Chat or Claude Code, a coordinator agent walks the workflow and you answer in the chat. With `metator run drive`, MetatorAI itself walks the stages: it starts each worker through your AI host, runs the scripts and gates, and stops at every decision that belongs to a person. You answer from any terminal, and the run can go on in the background while you work on something else.

Both modes use the same workflow spec, the same agents and hooks, and the same run state. A run started in one mode can finish in the other.

## In a terminal: one command

```bash
metator run
```

```text
┌  New MetatorAI run
◇  Which workflow?            mt-feature
◇  What is the task?          Add combined discount
◇  Autonomy                   L0 (you approve every gate)
◇  Which AI host?             Claude Code
◇  Work in its own git worktree? Yes
│  run 20261027-mt-feature-add-combined-discount · claude · Ctrl+C leaves; the run goes on
│  ▸ context · Parallel subagents survey the code (graph, patterns, rules)
│    mt-scout started
│      Bash metator graph dependents packages/billing/src/invoice.ts --transitive
│    ✓ PASS
│  ▸ plan-approval · The human approves the plan
◆  plan-approval · gate
│  The human approves the plan: approve to continue
│  ● Approve   ○ Reject   ○ Other
```

The run is driven in the background and shown live; every question is asked right there. **Ctrl+C leaves the view, not the run**: it goes on and waits for you.

```bash
metator run continue          # pick a run: "waits for you (1)", "driving" or "stopped", and watch it again
metator run continue <run>    # that run; a stopped one is driven again with the host it used
```

Everything below works the same without a terminal, for scripts and CI.

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
| `permission` | a worker wants a tool that is not pre-approved (Claude Code) | Allow runs the call; Deny refuses it, with your reason. The question shows a command whole |

**What a worker may do without asking** (Claude Code):
- the MetatorAI commands its definition names (`Bash(metator plan:*)` and the like), one command per call;
- reading and searching in the repository, the run directory and the linked repositories, also through the shell when the command only reads (`grep`, `sed -n`, `cat`, read-only `metator` queries such as `graph`, `api diff` or `findings validate`);
- writing its artifacts into the run directory;
- editing files inside the run's own worktree. The worktree is isolated, and nothing leaves it without you: a push always needs `metator run approve push`.

Anything else asks: an edit in your own checkout (a run without `--worktree`), other shell commands, a write anywhere outside. Claude Code itself always asks for a command it cannot read safely, such as a heredoc that holds JSON.

The same rules hold for the workers a coordinator starts (the review lenses). They run in the foreground of the stage's session, so their questions reach you too: a worker in the background would outlive the turn that started it, and its permission prompts could not be answered.

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

**An escalated run** (a gate red too often, a worker blocked after three answers) waits for you. Fix the cause, then resume it where it stopped:

```bash
metator run resume --run <id> --by alice   # back at the stage it escalated from; history and loop counts stay
metator run drive --run <id> --host claude --detach
```

## How a stage is carried

1. **A HITL stage** becomes a question (Approve, Reject, Other). Skipped stages (`skipAt` your autonomy level) never ask.
2. **Scripts** (`owner: "script:…"`) run with your `hosts.metatorCommand`. `{runDir}` in the command is the run directory, and `METATOR_RUN` and `METATOR_RUN_DIR` are set. The run's inputs fill their placeholders: `{base}` is the value from `run init --input base=main`, and `{base|HEAD}` falls back to `HEAD` when the run was started without it. An input with neither stops the run with the `--input` it needs; `run init` refuses an input the workflow does not declare (`input:` in its spec).
3. **Agents** run in order; `parallel` workers run together. Each gets one message: the stage, the task, where to write its artifacts, the skills it may use, notes about where it works (dependencies not installed there, so tests and the compiler cannot run) and, after a failed gate, why it failed. A stage a later one sent back (review → plan) hears which stage failed and why, and that the work done since is already in the run's working tree, so a step already done is not planned or built again; every stage until the failing one is reached again hears it. It must finish with `STATUS: done` or `STATUS: blocked: <question>`.
4. **Artifacts** listed in `produces` must exist in the run directory, or the stage fails. Workers of a parallel stage each write only their own. A coordinator without a Write tool writes one with `metator run write <artifact>` (the text on stdin); only an artifact the current stage produces is accepted.
5. **Gates:** `gate.script` must exit 0; the critic of `gate.llm` must end with `VERDICT: PASS`. A missing verdict is a FAIL, never a silent pass. The critic gets the same notes about where the run works, and the repository's configured gates (their reports in `.metator/gates/`) settle which checks a change needs: a check they do not configure, or one that cannot run there, is no reason to fail.
6. **Transitions** are the drive's: it sends `run advance` or `run approve` when the stage is done. An agent the drive started may not move the run itself (the host denies `metator run advance` and the like), and if the run moved anyway while a stage worked, the drive does not send that stage's outcome to the next stage. Transitions go through `run advance` and `run approve`. Loops, limits and escalation are the workflow's, exactly as in interactive mode.

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
