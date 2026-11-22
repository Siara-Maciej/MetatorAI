# Quick and debug changes

Two of the three ways in a chat are lighter than a full run. A **quick change** is a small change meant to stay: no plan, one short review, and it ends with a diff you look at. A **debug change** is an edit not meant for a commit, such as a `console.log`: made at once, and recorded so it can be taken out again. This page covers both.

## Quick changes

The chat suggests quick when `metator quick check` says the change is small enough: "This is too small for the full workflow: do it as quick?" On yes it starts `metator quick start`. A quick run then:

1. **build**: a worker makes the change in its own terminal, with a test when the behaviour changes;
2. **gate**: the repository's quick gate runs on the changed files (`metator gate quick`); a failure goes back to the build;
3. **fit**: the real diff is checked against the limits again;
4. **review**: one reviewer, `mt-quick-review`, reads the diff once and writes `quick-review.md`; a blocking finding (`BLOCKING: <n>` on its first line) sends the change back to the worker once;
5. **ready**: Home shows **Quick change ready: look at the diff**.

<WorkflowDiagram id="mt-quick" />

On the last card, **Open diff** opens the run's **Changes** and leaves the card where it is; **Fine** ends the run. Nothing is committed: the diff stays in your working tree. Commit it yourself, or tell the chat "commit it" ([Approvals and consent](./approvals.md#commit-and-push)).

### Small enough

Whether a change is quick is decided without a model, before the start and again from the real diff:

```bash
metator quick check --task "Round prices half-up" --files src/price.ts   # before: the files it is expected to touch
metator quick check --diff                                                 # after: what the working tree changed
```

```json
{"quick":false,"escalators":[{"id":"size","why":"6 files (limit 5)","source":"git diff"}],
 "thresholds":{"maxFiles":5,"maxLines":150,"maxDependents":10},"files":["…"]}
```

Any one escalator makes the change not quick, and each says why and which tool saw it:

| Escalator | Trips when |
|---|---|
| `cross-repository`, `contract` | the change reaches another repository or touches a contract of the system map (`metator system impact`) |
| `public-api` | a package's public API changes (its entry module, or `metator api diff` against a snapshot) |
| `package-boundary`, `dependents` | the files are in more than one package, or more than `quick.maxDependents` files depend on them |
| `migration`, `schema-version`, `dependency`, `ci-config` | a migration, a schema or a document's `schemaVersion`, a lockfile or an added dependency, CI configuration; before any file is known, the task's own words count too |
| `untested` | a changed source file that no test reaches |
| `size` | more than `quick.maxFiles` files or `quick.maxLines` changed lines |

The limits are in `metator.config.yml` ([Configuration](../reference/configuration.md#quick)).

### Start one

```bash
metator quick start --task "Round prices half-up" --files src/price.ts
```

`quick start` refuses:

- with the escalators that tripped. You may keep it quick with one sentence of your own, `--override "it is one rename, keep it quick"`, recorded with the run in your words. A change that reaches another repository can never be kept quick;
- up front when `gates.quick` has no steps: the run checks its change with that gate. `metator setup` writes it from your lint, typecheck and test scripts;
- on a checkout with uncommitted changes, with `dirty: pass --here or --worktree`. `--here` works in the checkout, and your changes become part of the change; `--worktree` works in a worktree of its own from the last commit. The chat asks you which.

### When it grows

When the real diff grows past the limits while it works, the run stops with the card **This grew past quick: …**, naming what tripped. **Keep as quick** goes on, recorded with your name. **Continue as full** starts a full run on the same working tree, with its own conductor, and closes the quick run.

## Debug changes

An edit you asked for that is not meant for a commit is recorded, so it can be taken out again and no commit takes it by accident. The chat does this for you when it edits directly; the commands are:

```bash
metator scratch begin                          # before the edit
metator scratch end --note "trace price calls" # after it: what changed in between is one record
metator scratch list                           # the records still in the working tree
metator scratch drop --all                     # take them out again (or --id s001)
```

`drop` reverse-applies each record's patch and leaves your other work in the same files. Nothing is forced.

### In the app

While there are some, **Debug changes (N)** shows on Home and in the bar of a task's terminals. A click lists them: the files, what each was for, and when.

- **Remove** takes one out of your files; **Remove debug changes** every one that can still be removed. A line says what was removed.
- A change whose lines, or the lines around them, were edited since cannot be taken out as recorded. It stays in the list, marked **Cannot be removed** with the reason, and still stops a commit. Take its lines out by hand, then **Forget**: the record goes and your files are not touched (`metator scratch forget --id s001`).
- A change you took out by hand is gone, and the list says so once: `s002 is gone: src/tax.ts no longer holds it.`

A recorded change never leaves the list without a line that says why.

### A commit that would take one

A `git commit` an agent runs that would take a recorded change is stopped: `this commit holds debug changes: src/price.ts`. That covers a staged change, `git commit -a`, paths named on the commit, and a `git add` in the same command line. Say "commit anyway", or remove them first.
