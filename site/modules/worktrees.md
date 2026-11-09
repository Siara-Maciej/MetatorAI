# Runs in worktrees

::: tip Module
You do not need this when one run at a time changes the repository.
:::

**What for:** a run that edits code in your working tree blocks you, and two runs at once disturb each other. A git worktree gives each run its own checkout of the repository, on its own branch, while sharing one `.git`. MetatorAI also gives every worktree its own block of ports, so two copies of your application never fight over port 3000.

## Start a run in its own worktree

```bash
metator run init --workflow mt-feature --task "Add combined discount" --worktree
metator run init --workflow mt-bugfix --task "Fix rounding" --worktree --base main
```

```json
{"runId":"20261027-mt-feature-add-combined-discount","stage":"intake",
 "worktree":{"id":"20261027-mt-feature-add-combined-discount",
             "path":".metator/wt/20261027-mt-feature-add-combined-discount",
             "branch":"metator/20261027-mt-feature-add-combined-discount"}}
```

**What it does:**
1. Runs `git worktree add` at `.metator/wt/<run>` on a new branch `metator/<run>`, branched from `--base` (default `HEAD`).
2. Leases a block of 20 ports that no other worktree holds and that nothing on this machine listens on.
3. Records the worktree in the run (`state.json`) and in `.metator/worktrees.json`.
4. Links `.metator/runs` of your checkout into the worktree and lists it in `.git/info/exclude`, so the run's agents, hooks and `metator plan` find the run at the same path, and git never sees the link. In the worktree, `metator run …` without `--run` means that worktree's run, even when another run started later. A MetatorAI setup you have not committed yet (`metator.config.yml`, `docs/metator/`, `.claude/agents`, `.claude/skills`, `.github/metator/`, …) is linked into the worktree file by file and ignored there only, so the run uses your gates, agents and skills, and your checkout still shows the setup as untracked until you commit it.

5. **Sets the worktree up** so the run's tests, type checker and linters can run there. A fresh `git worktree add` has no `node_modules`: when every lockfile is the same in both checkouts, the main checkout's `node_modules` (and those of its workspace packages) are copied, copy-on-write where the disk can (btrfs, XFS, APFS), so it takes seconds; otherwise the repository's package manager installs in the worktree (`bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `npm ci`, …). The result is in the output (`setup.dependencies`: `reused`, `installed`, `present`, `none`), and a failed install is a warning, not a failed run: the run starts, and `metator doctor --run <id>` says what it cannot do. `--no-setup` skips this step.

`metator setup` adds `.metator/` to your `.gitignore`: the worktrees live there, and so do run state and caches.

## Set a session up by hand

```bash
metator worktree setup --run <id>              # the run's worktree: dependencies as above
metator worktree setup --worktree spike --up   # a worktree of your own, and its services (metator env up --worktree)
metator doctor --run <id>                      # what this run can and cannot do in its worktree
```

`doctor --run` (or `--worktree`) looks at the session's own checkout: its `package.json` and `node_modules`, and, when the repository declares an [environment](environments.md), whether that worktree's services are running (`fix: metator env up --worktree <id>`). `--up` on `worktree setup` starts them; without an environment file it starts nothing and is no failure.

## See and manage worktrees

```bash
metator worktree list
```

```json
{"worktrees":[
  {"id":"20261027-mt-feature-add-combined-discount","branch":"metator/20261027-mt-feature-add-combined-discount",
   "ports":{"from":41000,"count":20},"run":"20261027-mt-feature-add-combined-discount","runStatus":"active","dirty":false},
  {"id":"20261027-mt-bugfix-fix-rounding","ports":{"from":41020,"count":20},"runStatus":"active","dirty":true}]}
```

```bash
metator worktree new spike --ports 5           # a worktree without a run, e.g. to try something by hand
metator worktree rm spike                      # refused while it holds uncommitted work
metator worktree rm spike --force              # removes it anyway; the work is lost
metator worktree prune --older-than 7          # worktrees of finished runs older than 7 days
metator worktree prune --dry-run               # what prune would remove
```

**Why:**
- **Uncommitted work is never removed silently.** `rm` refuses a worktree with changes unless you pass `--force`, and `prune` skips such worktrees and lists them under `keptDirty`.
- **Branches stay.** Removing a worktree keeps its `metator/<id>` branch, so committed work is never lost.

## Conflicts between sessions

Two runs in their own worktrees that change the same file will clash when their branches merge. See it before that:

```bash
metator worktree conflicts            # every active run's changed files, and the pairs that share one
metator worktree conflicts --notify   # also tell both runs (a shared-file message each way, read as data)
```

```json
{"changes":[{"runId":"20261102-mt-feature-a","worktree":"20261102-mt-feature-a","files":["src/invoice.ts"]},
            {"runId":"20261102-mt-feature-b","worktree":"20261102-mt-feature-b","files":["src/invoice.ts","src/web.ts"]}],
 "conflicts":[{"runs":["20261102-mt-feature-a","20261102-mt-feature-b"],"files":["src/invoice.ts"],"mergeFirst":"20261102-mt-feature-a"}],
 "notified":[]}
```

A worktree's changes are what it committed on its branch, what is in its working tree, and new files git does not ignore, all against the point it branched off. `mergeFirst` is the run that started earlier: merge it, and the other rebases on it. The daemon serves the same at `GET /conflicts`.

## Ports

Each worktree's block is in its entry (`ports.from`, `ports.count`). `metator worktree new` also returns it as variables:

```json
{"variables":{"METATOR_WORKTREE":"spike","METATOR_PORT_BASE":"41040","METATOR_PORT_COUNT":"5"}}
```

When MetatorAI starts your application in a worktree (`metator env up`), it passes these variables to every process. Base your port settings on `METATOR_PORT_BASE` (for example `PORT=$((METATOR_PORT_BASE + 0))` for the API and `+ 1` for the web app). Blocks come from 41000–48999, above the usual development ports and below the ephemeral range.
