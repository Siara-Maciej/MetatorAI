# Runs in worktrees

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

Add `.metator/` to your `.gitignore`. The worktrees live there, and so do run state and caches.

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

## Ports

Each worktree's block is in its entry (`ports.from`, `ports.count`). `metator worktree new` also returns it as variables:

```json
{"variables":{"METATOR_WORKTREE":"spike","METATOR_PORT_BASE":"41040","METATOR_PORT_COUNT":"5"}}
```

When MetatorAI starts your application in a worktree (`metator env up`), it passes these variables to every process. Base your port settings on `METATOR_PORT_BASE` (for example `PORT=$((METATOR_PORT_BASE + 0))` for the API and `+ 1` for the web app). Blocks come from 41000–48999, above the usual development ports and below the ephemeral range.
