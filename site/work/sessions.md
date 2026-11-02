# Sessions and terminals

**What for:** several runs going at once, each in its own worktree, and one place to see what each one does, which one waits for you and for what, to answer it, start its application, open its code and ask about it. Both ways of working, in chat and from the terminal, use the same workflow spec, the same agents and hooks and the same run state: a run started in one can finish in the other.

## Start a run from the terminal

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

MetatorAI itself walks the stages: it starts each worker through your AI host, runs the scripts and gates, and stops at every decision that belongs to a person. The run is driven in the background and shown live. **Ctrl+C leaves the view, not the run**: it goes on and waits for you.

```bash
metator run continue          # pick a run: "waits for you (1)", "driving" or "stopped", and watch it again
metator run continue <run>    # that run; a stopped one is driven again with the host it used
```

Everything below works the same without a terminal, for scripts and CI:

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run drive --host claude --detach       # or --host copilot; default: first of hosts.targets
metator run questions
metator run answer q001 --choice Approve --by alice
metator run answer q002 --choice Reject --text "split step 3 into two" --by alice
```

**Questions come from three places:**

| `source` | When | What your answer does |
|---|---|---|
| `gate` | a HITL stage (plan approval, push, comments) | Approve continues; Reject sends the run back with your reason |
| `agent` | a worker asks (`AskUserQuestion` in Claude Code, `STATUS: blocked: …` from any host) | the answer goes back to the same agent session, which continues |
| `permission` | a worker wants a tool that is not pre-approved | Allow runs the call; Deny refuses it, with your reason |

What a worker may do without asking: the MetatorAI commands its definition names, reading and searching in the repository (also through the shell when the command only reads), writing its artifacts into the run directory, and editing files inside the run's own worktree. Anything else asks. A push always needs `metator run approve push`.

## The session screen

```bash
metator ui
```

```text
 MetatorAI · shop                                        1 need you · 1 driving · 0 stopped · 1 services
╭ SESSIONS ─────────────────────────────╮╭──────────────────────────────────────────────────────────────╮
│ ? Add combined discount · plan-approval││ Add combined discount                                         │
│ ⟳ Fix rounding of VAT · build          ││ 20261028-mt-feature-add-combined-discount · mt-feature · L0 ·  │
│ ✓ Docs links · done                    ││   claude · 7 min                                              │
│ Conversations                          ││ ? needs you · waits for you: approve the plan  (a: answer)    │
│ ✦ How is VAT computed?                 ││ intake ✓ ─ context ✓ ─ plan ✓ ─ [plan-approval ?] ─ build ·   │
│                                        ││  Overview  Activity  Apps                                     │
╰────────────────────────────────────────╯╰──────────────────────────────────────────────────────────────╯
 ↑↓ select · ⏎ act · tab view · a answer · n new run · ? ask · c continue · : all commands · , settings · q quit
```

- **The header:** how many sessions need you, how many are driving, stopped or escalated, how many services run.
- **Sessions on the left:** runs, the ones that need you first, then the conversations of [`metator ask`](./ask.md). In a [folder of repositories](../modules/repositories.md), every repository's runs under its name; finished runs fold into one line.
- **The selected session on the right:** what it needs now and the key that does it; its stages (`✓` done, `⟳` working, `?` waits for you, `!` stopped); three tabs: **Overview** (questions, last event, worktree and ports), **Activity** (live) and **Apps** (the worktree's services).

| Key | Does |
|---|---|
| `↑` `↓` | select a session · `⏎` what it needs: answer, continue, resume, follow up |
| `a` | answer the run's question; at a human gate, approve or reject with a reason |
| `c` · `x` | continue the run (an escalated run is resumed first) · stop its drive |
| `n` · `?` · `r` | new run · ask about the code · follow up in the selected conversation |
| `u` · `w` | start · stop the run's applications |
| `e` · `t` · `d` | open the worktree in your editor · a shell there · the run's diff |
| `g` | go to the next session that needs you |
| `,` · `:` | settings · every action by name |

An answer is carried out by the run's drive: when none is running, `metator ui` starts it again with the host that drove the run. The view refreshes by itself; the terminal bell rings when a new question arrives.

## Watch, stop, continue

```bash
metator run activity --tail 8            # the run's events: stages, agents, tools, questions, gates
metator run stop                         # the drive process ends; the run stays at its stage
metator run drive --host claude --detach  # continue later: the same open question is not asked twice
```

`.metator/runs/<id>/activity.jsonl` holds every event, one versioned JSON object per line. A run has at most one live driver.

**An escalated run** (a gate red too often, a worker blocked after three answers) waits for you. Fix the cause, then resume it where it stopped:

```bash
metator run resume --run <id> --by alice   # back at the stage it escalated from; history and loop counts stay
metator run drive --run <id> --host claude --detach
```

## How a stage is carried

1. **A human gate** becomes a question (Approve, Reject, Other). Stages skipped at your autonomy level never ask.
2. **Scripts** (`owner: "script:…"`) run with your `hosts.metatorCommand`; `{runDir}` and the run's inputs fill their placeholders.
3. **Agents** run in order; `parallel` workers run together. Each gets one message: the stage, the task, where to write its artifacts, the skills it may use and, after a failed gate, why it failed. What you answered earlier in your own words goes into every later agent's message as a decision to follow.
4. **Artifacts** listed in `produces` must exist in the run directory, or the stage fails.
5. **Gates:** `gate.script` must exit 0; the critic of `gate.llm` must end with `VERDICT: PASS`; a missing verdict is a fail, never a silent pass.
6. **Transitions** are the drive's: an agent may not move the run itself.

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

## What comes next: terminals, a driver and a supervisor

::: info Planned
The following is the specified next step of sessions. It is not in the CLI yet; this page will change when it lands. The concept it builds on is [Session](../concepts/session.md).
:::

- **The host's CLI in a terminal MetatorAI owns.** Instead of a headless drive, Copilot CLI (first), Claude Code and OpenCode run interactively in a terminal per session. The hooks observe what the agent does; the terminal is read-only until you attach.
- **A driver lock.** *Attach* pauses the agent and gives the terminal your keyboard; an approval you give in that chat counts and is recorded as an approval through the CLI, only while you hold the lock. *Release* gives the terminal back. One terminal, one driver.
- **Sessions by application or by run.** A feature that spans several applications is one group: its steps numbered in order, with the deploy wave; the same tag marks the steps in every view.
- **A grid of terminals.** A group, or sessions you pin, side by side: one, two by two or three by three; only the tile you attached to has an input line.
- **Since you left.** Coming back to a session opens a briefing built from `log.md`, the gate reports and the events: stages passed, decisions and their reasons, files changed, red gates with their output, and what the session needs from you. Nothing in it is written by a model.
- **A supervisor.** Keeps every session alive: restarts a host process that exited, with resume; nudges a session that went idle with no open question, then escalates; keeps no more than your attention limit of sessions waiting at once.
- **Links between sessions.** Parent and children, messages one run leaves for another (a contract published, a file shared) delivered as data, and the files two sessions' scopes share, with a suggested merge order.

The decision inbox that goes with it is on [Inbox and decisions](./inbox.md).

## Without a terminal

`metator ui` needs one; in a script it fails with `USAGE`. Use `metator status` for the overview, and the commands `ui` is made of: `run continue`, `run questions`, `run answer`, `env up|down|status|logs`, `worktree list`.

## Next

- [Runs in worktrees](../modules/worktrees.md), [Start the application](../modules/environments.md): the workspace underneath a session.
- [Several repositories](../modules/repositories.md): one screen for every repository on the machine.
