# Sessions and worktrees

A session is a run together with the place it works in. This page shows how to give each run its own checkout, see what every session does, stop and continue one, and clean up afterwards.

## Give a run its own worktree

A run that edits your working tree blocks you, and two runs in one tree disturb each other. A git worktree gives a run its own checkout on its own branch.

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run init --workflow mt-bugfix --task "Fix rounding" --worktree --base main
```

With `--worktree`, MetatorAI:

1. creates a worktree at `.metator/wt/<run>` on a new branch `metator/<run>`, branched from `--base` (default `HEAD`);
2. reserves a block of 20 ports for it that no other worktree holds;
3. links the run directory into the worktree, so agents and hooks find the run at the same path;
4. sets up dependencies, so tests and linters can run there.

For the dependencies, the main checkout's `node_modules` are copied when the lockfiles match. Otherwise your package manager installs in the worktree. A failed install is a warning and the run still starts. `--no-setup` skips this step, and you can run it later:

```bash
metator worktree setup --run <id>
metator doctor --run <id>        # what this run can and cannot do in its worktree
```

Inside a worktree, `metator run ...` without `--run` means that worktree's run.

`metator run`, the agent's intake conversation and `metator issue start` all offer a worktree too.

## See every session

```bash
metator status      # every run: its stage, what waits for you, its driver
metator ui          # the same as a full-screen view in the terminal
```

`metator ui` lists the sessions on the left, the ones that need you first, followed by your [`metator ask`](./ask.md) conversations. The right side shows the selected session: what it needs now, its stages, and three tabs for the overview, the live activity and the worktree's applications. The footer names the keys. `metator ui` needs a terminal. In a script, use `metator status`.

The [desktop app](./desktop.md) shows the same sessions with their terminals.

## Watch, stop and continue

```bash
metator run activity --tail 8     # the last events: stages, agents, tools, questions, gates
metator run stop                  # the drive process ends; the run stays at its stage
metator run continue <run>        # drive it again and watch
```

A run has one driver at a time. A second `metator run drive` is refused while the first is alive. An open question is not asked twice when you continue.

If the machine restarts or the drive process is killed, `metator status` marks the run as died. One command starts every such drive again, at the stage it stood:

```bash
metator run revive
```

It does nothing when no drive died, so you can schedule it at boot.

## Hand a run over

```bash
metator run handoff       # writes handoff.md: stage, approvals, artifacts, recent log, how to resume
metator run brief         # what happened since you last looked
```

## Close a run

```bash
metator run close --run <id>
metator run close --run <id> --remove-worktree
metator run close --run <id> --aborted --reason "superseded"
```

`run close` writes `summary.json`. `--remove-worktree` also removes the run's worktree and frees its ports. `--aborted` ends a run that is still active.

## Manage worktrees

```bash
metator worktree list                     # branch, ports, run status, uncommitted work
metator worktree new spike --ports 5      # a worktree without a run
metator worktree rm spike
metator worktree prune --older-than 7     # worktrees of finished runs older than 7 days
metator worktree prune --dry-run
```

Removing a worktree keeps its `metator/<id>` branch, so committed work stays. `prune` skips worktrees with uncommitted work and lists them.

::: warning
`metator worktree rm <id> --force` and `metator run close --remove-worktree --force` delete uncommitted work in that worktree. Without `--force` both refuse.
:::

## Conflicts between sessions

Two runs that change the same file clash when their branches merge. Check before that happens:

```bash
metator worktree conflicts
metator worktree conflicts --notify
```

The output lists each active run's changed files and the pairs of runs that share one. `mergeFirst` names the run that started earlier: merge it, then rebase the other. `--notify` sends both runs a message about the shared file.

Runs can also tell each other what they did:

```bash
metator run message <to> --from <run> --topic shared-file --text "Invoice gained a dueDate field" --ref src/invoice.ts --by alice
metator run messages --run <to>
```

The receiving run's agents read the message as data about another run's work. They do not treat it as an instruction.

## Ports

Each worktree gets its block from the range 41000 to 48999. When MetatorAI starts your application in a worktree (`metator env up`), every process gets these variables:

| Variable | Value |
|---|---|
| `METATOR_WORKTREE` | the worktree's id |
| `METATOR_PORT_BASE` | the first port of the block |
| `METATOR_PORT_COUNT` | the size of the block |

Base your port settings on `METATOR_PORT_BASE`, for example `PORT=$((METATOR_PORT_BASE + 0))` for the API and `+ 1` for the web app. Two copies of your application then never share a port. See [Run the application](../repo/environments.md).
