# Terminals, panes and the conductor

**What for:** a run's agents in real terminals you can watch and step into: the host CLI in a pane of its own, a conductor that hands work to workers in their panes, states the daemon reads without asking, one keyboard owner at a time, and runs that talk to each other. The chat and the headless drive on [Sessions and terminals](./sessions.md) use the same run state; a run started there can be conducted here.

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

`metator attach <pane>` does both in one go, in your terminal: it takes the run's driver lock under your name, puts your terminal in raw mode on the pane's socket (every key goes to the pane, every byte comes back, the size follows your window) and gives the lock back when you detach with `Ctrl-]` (keep it with `--keep`). A run id names its conductor pane; a shell pane, of a run or of none, takes anyone's keys without a lock: the lock guards the agent's panes.

```bash
metator attach w1:p2 --by alice           # the worker pane w1:p2 (metator pane list names them)
metator attach 20261109-feature-x        # the run's conductor pane
```

An agent that heard you say yes runs `metator run approve <gate> --by alice --via chat`. That command is accepted only while you are attached, only under your name, and never for the push or a PR comment: in a driven session the hook refuses it otherwise, as it refuses every other run control by an agent. Every attach, release and approval from the chat is a line in `log.md` (who, when) and a `driver` entry in the activity. `metator status` shows `driver` and `attachedBy` for each run.

## Splits

A pane's area can be split like in herdr: the new pane takes the second half, and the tab remembers the tree (`Layout` v2) so a daemon started again lays the panes out the same way.

```bash
metator pane split w1:p2 --dir down                 # a shell below the pane (your shell, else $SHELL)
metator pane split w1:p2 --dir right --argv top     # any command beside it
```

The desktop app does the same with `prefix+v` / `prefix+-`, a right click, or a drag of the divider; `prefix+z` zooms one pane and back; `prefix+[` is copy mode, a search over the pane's scrollback with `y` to copy the selection.

## Messages between runs

Two runs working side by side (a feature split into steps, a change that touches a file both edit) tell each other what they did:

```bash
metator run message <to> --from <run> --topic shared-file --text "Invoice gained a dueDate field" --ref src/invoice.ts --by alice
metator run messages --run <to>
```

Topics: `info`, `contract`, `shared-file`, `done`. The message is a `RunMessage` document in the receiving run's `messages/`, noted in both runs' activity, and read by the receiving run's agents at their next stage under a header that says it is data about another run's work, not an instruction. Hooks never read its text.


## Close, and a drive that died

```bash
metator run stop                         # the drive process ends; the run stays at its stage
metator run drive --host claude --detach  # continue later: the same open question is not asked twice
```

A run has at most one live driver. A second `run drive` is refused while the first is alive, and a driver that died does not block a new one.

A run conducted from a pane is kept alive the same way: when its conductor's session ends while the run is still active (the host quit, the process was killed), the supervisor in the daemon resumes the session in the same pane, up to `supervisor.respawn.maxAttempts` times, and then says it gave up in the run's activity; a session a person holds (attached) is left alone. Workers are the conductor's to start again.

`metator run close` ends the run's panes too when a daemon holds them (its workspace goes, the repository's workspace stays), and `--remove-worktree` (with `--force` for uncommitted changes) removes the run's worktree and frees its ports:

```bash
metator run close --run <id> --remove-worktree
```

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


## What the runs cost

```bash
metator report                      # every run; --since 2026-11-01 for the runs started since then
```

```json
{"totals":{"runs":12,"done":10,"calls":131,"agentMs":5130000,"inputTokens":2410000,"outputTokens":188000,"cachedTokens":1900000,"costUsd":41.2,
  "questions":27,"byPolicy":9,"personWaitMs":2640000,"failures":4},
 "runs":[{"runId":"…","workflow":"mt-feature","status":"done","wallMs":1860000,
   "usage":{"calls":11,"costUsd":3.4,"…":"…"},"questions":{"asked":2,"byPolicy":1,"bySource":{"gate":2},"waitMs":120000},"failures":0}],
 "agents":[{"agent":"mt-pr-review","calls":12,"costUsd":14.1,"agentMs":1500000,"failed":0,"questions":0},{"agent":"mt-implementer","…":"…"}]}
```

Every agent call leaves one line in `.metator/runs/<id>/usage.jsonl` (`AgentUsage`): its stage, agent, outcome, wall time and, when the host reports them, tokens, cached tokens and cost (Claude Code does; the Copilot CLI and the scenario host report none, so their calls count time only). The report adds what the runs asked of people: questions asked, how many an [answer policy](./inbox.md) took, how long people's answers were waited for, and how often a gate or review sent a run back (`failures`). `agents` ranks the agents by cost, with their failed calls and the questions they stopped for: the ones to tune first. In a folder of repositories the report spans them all, each run named `<repo>/<run>`.

`metator ui` needs one; in a script it fails with `USAGE`. Use `metator status` for the overview, and the commands `ui` is made of: `run continue`, `run questions`, `run answer`, `env up|down|status|logs`, `worktree list`.

## Next

- [The desktop app](./desktop.md): the same panes as a grid, with the inbox beside them.
- [Inbox and decisions](./inbox.md): what a blocked pane and a worker's question become.
