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

**Every question carries its decision card** (`card`), so you can answer without opening the run: the task, the stages the run passed, the artifacts written so far, the option the evidence points to and whether the answer can be taken back. MetatorAI composes it from the run's own record when it asks, never with a model:

```json
"card":{"task":"Add combined discount","done":["setup","intake","context","plan","plan-gate"],
  "artifacts":["analysis.json","plan.json","plan-scope.json","task.md"],
  "recommended":"Approve","reversible":true}
```

A gate recommends Approve only when the stage before it passed. The delivery gate, which grants the push, is `reversible: false`, as is closing a run whose worker found nothing to do. `metator ui` shows the card above the options and marks the recommended one.

The card also says (each from the run's own files, none from a model):

| Field | What | From |
|---|---|---|
| `soFar` | transitions and tool calls since you last answered | `activity.jsonl` |
| `evidence` | each gate report: `full: passed (lint ✓, rules ✓, test ✓)` | `.metator/gates/*.json` |
| `consequences` | what each answer does: `Approve` → the next stage; `Reject` → back to the stage `onFail` names, with the loop count and limit | the workflow spec, the run's loops |
| `blastRadius` | how many files the plan touches and the top-level areas they are in | `plan-scope.json` |
| `costOfDelay` | ports the worktree holds, loops used, child runs waiting on this one | the worktree registry, the run |
| `group` | the parent run and this run's step among its children | `parent`, `children` |

**All your decisions in one queue**, across runs (and across the repositories of a folder):

```bash
metator inbox
```

```json
{"decisions":[{"runId":"20261027-mt-feature-add-combined-discount","stage":"plan-approval","driving":true,
  "waitedMs":420000,"question":{"id":"q001","source":"gate","card":{"recommended":"Approve"}}}]}
```

First the decisions a live drive waits on (that run stands still until you answer), then the ones that have waited longest.

**Answer once, for good.** Questions the team always answers the same way become answer policies:

```bash
metator run answer q001 --choice Approve --by alice --always
```

The answer goes to the run, and `metator/answer-policies.yml` gets a policy for the same question (its source, stage, agent and, for a gate, the recommendation it came with). From then on such a question is answered the moment it is asked, by `policy:<id>`, and the run does not wait. Commit the file: the team reviews policies like code. `metator policy list` shows them, `metator policy rm <id>` puts such questions back to a person.

A policy only answers where a wrong answer costs less than a question:
- a gate only while its card recommends the same answer (a plan approval after the plan gate passed, never after it failed);
- never a decision that cannot be taken back (the push, closing a run);
- never Allow for a tool (a policy may Deny one, e.g. `when: { source: permission, promptIncludes: "npx " }`);
- never Other or Reject, which need your own words.

**Questions come from three places:**

| `source` | When | What your answer does |
|---|---|---|
| `gate` | a HITL stage (plan approval, push, comments) | Approve continues; Reject sends the run back with your reason |
| `agent` | a worker asks (`AskUserQuestion` in Claude Code, `STATUS: blocked: …` from any host) | the answer goes back to the same agent session, which continues |
| `permission` | a worker wants a tool that is not pre-approved (Claude Code) | Allow runs the call; Deny refuses it, with your reason. The question shows a command whole |

**What a worker may do without asking** (Claude Code):
- the MetatorAI commands its definition names (`Bash(metator plan:*)` and the like), one command per call;
- reading and searching in the repository, the run directory and the linked repositories, also through the shell when the command only reads (`grep`, `sed -n`, `cat`, `readlink`, git that only reads such as `git status`, `git log` or `git diff` without `--output` or `--ext-diff`, read-only `metator` queries such as `graph`, `api diff` or `findings validate`);
- writing its artifacts into the run directory;
- editing files inside the run's own worktree. The worktree is isolated, and nothing leaves it without you: a push always needs `metator run approve push`.

An agent whose definition grants no plain `Bash` (a coordinator such as `mt-pr-review`, a planner, a review lens) is never put to you for a shell command: anything outside its declared commands and reading is refused at once, with the reason, and it carries on with its own tools or hands the work to an agent that runs code (`mt-verifier`). Its subagents have definitions of their own.

For the other agents, anything else asks: an edit in your own checkout (a run without `--worktree`), other shell commands, a write anywhere outside. Claude Code itself always asks for a command it cannot read safely, such as a heredoc that holds JSON. Every stage tells its agents to read and change files with Read, Edit and Write, never with an interpreter (`python`, `node`, `jq`), which would ask you each time.

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
  {"type":"stage","stage":"gates","text":"The repository's configured gates (metator gate full)"},
  {"type":"tool","stage":"gates","text":"$ metator gate full"}]}
```

`.metator/runs/<id>/activity.jsonl` holds every entry, one versioned JSON object per line. It is the record the live view and the session UI read.

**Back after a while?** Ask for the brief instead of reading the log:

```bash
metator run brief --run <id>
```

```json
{"runId":"…","status":"active","stage":"review","since":"2026-11-02T09:12:00.000Z",
 "transitions":["build PASS","gates PASS"],"files":["/repo/.metator/wt/…/src/discount.ts"],
 "answers":["q002: Approve · alice"],"questions":[],"errors":[],"tools":41,"last":"… stage: Find in parallel…"}
```

It covers what happened since your last brief of that run (the first one: since the run started), and remembers that you read it (`.metator/runs/<id>/seen.json`). `--peek` reads without marking; `--since <ISO time>` picks the start yourself. The brief is built from the activity alone, so it is exact and costs nothing.

## Interactive hosts

The daemon (`metator serve`) and the desktop app open a run's session in a real terminal: the host CLI runs in a pseudo-terminal in the run's worktree, started with the task, and the run's hooks write its activity. The hosts, in the order `supervisor.hostOrder` gives (the first is the default of a new session):

| Host | Starts | Resumes | Session id |
|---|---|---|---|
| `copilot` | `copilot -i <task> --add-dir <run dir> --deny-tool "shell(git push)"` | `copilot --continue` (or `--resume <id>` when a real id is known) | `continue`: Copilot names its sessions itself; the worktree's last session is the run's |
| `claude` | `claude <task> --session-id <uuid> --add-dir <run dir> --permission-mode default` | `claude --resume <uuid>` | the UUID MetatorAI chose |
| `opencode` | `opencode <worktree> --prompt <task>` | `opencode --continue` (or `--session ses_…`) | `continue` |
| `scenario` | a shell script that plays the scenario's entry for the agent, else its `session` entry | the next entry | `scenario-<agent>-N` |

The run's agent (`--agent <id>`) is passed when the repository has that agent's file for the host (`.github/agents/<id>.agent.md`, `.claude/agents/<id>.md`, `.opencode/agent/<id>.md`). Every session gets `METATOR_RUN`, `METATOR_RUN_DIR` and, in a driven run, `METATOR_DRIVEN=1` in its environment, so the hooks know which run they write to. The binaries come from PATH; `METATOR_COPILOT_BIN`, `METATOR_CLAUDE_BIN` and `METATOR_OPENCODE_BIN` point elsewhere.

```bash
curl -X POST localhost:4310/runs/<run>/pty-open -d '{"host":"claude","cols":120,"rows":40}'
```

## The conductor and its workers

A run can be conducted from a pane instead of driven by `metator run drive`: the orchestrator agent sits in an interactive host session (the conductor pane) and moves the run with `metator run` commands, each worker in a pane of its own. The workflow stays the law (stages, their agents, human gates, loop and parallel limits); within it, the conductor decides what to do and when.

```bash
metator run start                                            # the run's workspace with the conductor pane (mt-orchestrator)
metator run delegate plan --agent mt-planner --card "Plan the discount in src/invoice.ts; write plan.json; summary of at most 10 lines"
metator run workers                                          # who works now, in which pane, with which result so far
metator run wait mt-planner-1 --timeout 600000               # until it reported, its pane ended, or it sits idle without a report
metator run collect mt-planner-1                             # its result (summary, artifacts, a question when blocked); closes its pane
```

The card is the worker's whole task, handed over once; the worker writes its artifacts into the run directory and reports with one command, from its own pane:

```bash
metator run result --worker mt-planner-1 --status done --summary "plan.json: 4 steps" --artifact plan.json
metator run result --worker mt-planner-1 --status blocked --question "Round half up or half even?" --summary "two readings of the spec"
```

A `blocked` report becomes a question in the inbox under the worker's name; the conductor collects it, decides or asks you, and delegates again with the answer in the card. Nobody types into another pane and no result travels through a terminal: the report is a `WorkerResult` file in `.metator/runs/<id>/results/`, the card a file in `work/`, and a worker's name (`<agent>-<n>`) is never reused in a run.

Who may do what is enforced, not asked for: the daemon accepts `start`, `delegate` and `collect` from the run's conductor pane (every pane carries a token in `METATOR_PANE_TOKEN`) or from a person's shell, and answers 403 to any other pane; the hooks of a worker pane (`METATOR_ROLE=worker`) deny every run-control command except its own `run result`; the conductor's hooks, like a coordinator's, deny edits to code.

## What a pane is doing

The daemon reads each pane without asking its agent (`metator pane list`, `GET /panes/<id>/state`, `metator pane wait <pane> --until blocked`):

| State | Read from |
|---|---|
| `working` | output in the last `quietMs`, or a hook call from the pane (`metator guard …` carries the pane's token as a heartbeat) |
| `blocked` | the host's own permission prompt on the screen ("Allow … to run?", "(y/n)"): only a person answers it |
| `waiting` | a MetatorAI question of the run waits in the inbox |
| `idle` | the host's prompt line, or quiet for longer than `quietMs` |
| `exited` | the process ended; `exitCode` says how |

How to read a host is a `HostManifest` v1: the screen patterns of its permission prompt and of its idle prompt, `quietMs`, whether its hooks run `metator guard`. MetatorAI ships one for `copilot`, `claude`, `opencode` and `scenario`; `metator/hosts/<host>.yml` in the repository replaces it (the Copilot patterns are an approximation until calibrated on your terminal: the hooks give a sure `working`, the exit a sure end).

A `blocked` pane of a run is a decision for you: the supervisor puts it in the inbox as a question of the run ("copilot waits for your answer in pane w1:p2: Allow …?") with two choices, *Attach and answer in the pane* (the daemon takes the driver lock under your name, the desktop opens the pane) and *Leave it*. `notify.command` runs for it like for any question. Nothing is ever typed into the host's prompt for you; when the screen moves on, the inbox item is closed as answered in the pane.

## Attach to a session

A session has one driver at a time: the agent, or a person who attached. Attaching takes the keyboard (the daemon routes your input to the session's PTY) and makes your yes in the chat count:

```bash
metator run attach --by alice            # the lock is yours; another person is refused until you release
metator run release
```

`metator attach <pane>` does both in one go, in your terminal: it takes the run's driver lock under your name, puts your terminal in raw mode on the pane's socket (every key goes to the pane, every byte comes back, the size follows your window) and gives the lock back when you detach with `Ctrl-]` (keep it with `--keep`). A run id names its conductor pane; a shell pane of no run takes anyone's keys without a lock.

```bash
metator attach w1:p2 --by alice           # the worker pane w1:p2 (metator pane list names them)
metator attach 20261109-feature-x        # the run's conductor pane
```

An agent that heard you say yes runs `metator run approve <gate> --by alice --via chat`. That command is accepted only while you are attached, only under your name, and never for the push or a PR comment: in a driven session the hook refuses it otherwise, as it refuses every other run control by an agent. Every attach, release and approval from the chat is a line in `log.md` (who, when) and a `driver` entry in the activity. `metator status` shows `driver` and `attachedBy` for each run.

## Messages between runs

Two runs working side by side (a feature split into steps, a change that touches a file both edit) tell each other what they did:

```bash
metator run message <to> --from <run> --topic shared-file --text "Invoice gained a dueDate field" --ref src/invoice.ts --by alice
metator run messages --run <to>
```

Topics: `info`, `contract`, `shared-file`, `done`. The message is a `RunMessage` document in the receiving run's `messages/`, noted in both runs' activity, and read by the receiving run's agents at their next stage under a header that says it is data about another run's work, not an instruction. Hooks never read its text.

## Stop and continue

```bash
metator run stop                         # the drive process ends; the run stays at its stage
metator run drive --host claude --detach  # continue later: the same open question is not asked twice
```

A run has at most one live driver. A second `run drive` is refused while the first is alive, and a driver that died does not block a new one.

**A drive that died** (the machine restarted, the process was killed) leaves its `driver.json` behind. `metator status` marks the run `died: true`, `metator ui` says `the drive died at <stage>`, and one command starts every such drive again, at the stage it stood and with the host it used:

```bash
metator run revive              # every run whose drive died; --run <id> for one
```

A drive that left on purpose (the run finished, `run stop`, the AI host out of capacity) is not revived. `run revive` does nothing when nothing died, so it is safe to schedule, for example `@reboot cd /path/to/repo && metator run revive` in cron.

**An escalated run** (a gate red too often, a worker blocked after three answers) waits for you. Fix the cause, then resume it where it stopped:

```bash
metator run resume --run <id> --by alice   # back at the stage it escalated from; history and loop counts stay
metator run drive --run <id> --host claude --detach
```

## How a stage is carried

1. **A HITL stage** becomes a question (Approve, Reject, Other). Skipped stages (`skipAt` your autonomy level) never ask.
2. **Scripts** (`owner: "script:…"`) run with your `hosts.metatorCommand`. `{runDir}` in the command is the run directory, and `METATOR_RUN` and `METATOR_RUN_DIR` are set. The run's inputs fill their placeholders: `{base}` is the value from `run init --input base=main`, and `{base|HEAD}` falls back to `HEAD` when the run was started without it. An input with neither stops the run with the `--input` it needs; `run init` refuses an input the workflow does not declare (`input:` in its spec).
3. **Agents** run in order; `parallel` workers run together. Each gets one message: the stage, the task, where to write its artifacts, the skills it may use, notes about where it works (dependencies not installed there, so tests and the compiler cannot run) and, after a failed gate, why it failed. What you answered earlier in the run in your own words (the text of an answer) goes into every later agent's and critic's message as a decision to follow, so a critic does not fail the work for doing what you decided. A stage a later one sent back (review → plan) hears which stage failed and why, and that the work done since is already in the run's working tree, so a step already done is not planned or built again; every stage until the failing one is reached again hears it. It must finish with `STATUS: done`, `STATUS: blocked: <question>` or `STATUS: nothing to do: <evidence>`.
   **Nothing to do.** A worker that finds the task already done in the code, or asking for no change, names where (`STATUS: nothing to do: index.js:41 passes options.signal`). You get one decision instead of a question in prose: **Close the run** (it ends as aborted, the evidence in its log) or **Do it anyway** (the worker goes on, with your words if you give any). A headless run (L2) closes on the evidence without asking.
4. **Artifacts** listed in `produces` must exist in the run directory, or the stage fails. Workers of a parallel stage each write only their own. A coordinator without a Write tool writes one with `metator run write <artifact>` (the text on stdin); only an artifact the current stage produces is accepted.
5. **Gates:** `gate.script` must exit 0; the critic of `gate.llm` must end with `VERDICT: PASS`. The critic is told that `metator review diff --base HEAD` shows the change and `metator help` lists the commands, so it does not guess at others. A missing verdict is a FAIL, never a silent pass. The critic gets the same notes about where the run works, and the repository's configured gates (their reports in `.metator/gates/`) settle which checks a change needs: a check they do not configure, or one that cannot run there, is no reason to fail.
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
