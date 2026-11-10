# Session

A session is a run with a place to work and a way to watch it: its own git worktree with a block of free ports, its application services, a drive that walks the stages through your AI host, and the questions it asks you. Several sessions run at once without stepping on each other, and one screen shows them all.

## Why it exists

With several agents working at once, the hard part is not generating code but knowing what each one is doing, which one waits for you, and answering without rebuilding its whole context in your head. A session makes each run observable (its events), addressable (continue, answer, stop) and safe to run next to the others (its own worktree and ports).

## Where it lives

| File | What |
|---|---|
| `.metator/worktrees/` and `metator/<run>` branches | the run's worktree, taken from a warm pool when one is ready |
| the machine's state directory (`~/.local/state/metator`) | port blocks leased across every repository on the machine |
| `.metator/runs/<id>/state.json` → `latest` | the live drive: process, host, started at |
| `.metator/runs/<id>/activity.jsonl` | the events of the session: stages, agents, tools, questions, answers, gates |
| `.metator/runs/<id>/questions/` | open questions and their answers |
| `.metator/env/` | the environment of the worktree: services, ports, data isolation |

## Commands

```bash
metator run init --workflow mt-feature --task "…" --worktree    # a run with its own worktree and ports
metator run drive --host claude --detach                        # walk the stages through the host
metator run questions  ·  metator run answer q001 --choice Approve --by alice
metator run activity --tail 8  ·  metator run stop  ·  metator run continue
metator ui                                                       # every session, what needs you, apps
metator status                                                   # the same overview as JSON
```

## What enforces it

- A run has at most one live drive; a second `run drive` is refused while the first is alive.
- An agent the drive started may not move the run itself; the host denies `metator run advance` and the like.
- Port blocks are leased for the whole machine, so two repositories never collide; the Compose project is per repository.
- An escalated run stops and waits; `run resume` puts it back at the stage it escalated from, keeping history and loop counts.

## One example

```bash
$ metator status
{"ok":true,"data":{"runs":[{"runId":"20261028-mt-feature-add-discount","task":"Add discount","attention":"you","stage":"plan-approval",
   "questions":[{"id":"q001","source":"gate","prompt":"The human approves the plan: approve to continue"}],
   "host":"claude","driving":false,"elapsedMs":420000,
   "worktree":{"branch":"metator/20261028-mt-feature-add-discount","ports":{"from":41000,"count":20}}}],
 "counts":{"you":1,"driving":0,"stopped":0,"escalated":1,"finished":3,"questions":1,"services":1}}}
```

## What comes next

::: info Planned
The next step of sessions, specified and designed, adds a **driver**: the host's CLI runs interactively in a terminal MetatorAI owns, the agent drives until a person attaches, and an approval given in that chat counts only while the person holds the lock. A **supervisor** keeps sessions alive (restart with resume, idle detection, an attention limit), and a feature spanning several applications is one **group** of sessions shown as a tree. See [Sessions and terminals](../work/terminals.md).
:::

## Related

- [Sessions and terminals](../work/sessions.md): driving and answering, step by step.
- [Inbox and decisions](../work/inbox.md): answering from one queue.
- [Runs in worktrees](../modules/worktrees.md), [Start the application](../modules/environments.md): the workspace underneath.
