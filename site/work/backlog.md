# The backlog

**What for:** the repository's own task list, in `.metator/issues/`, one small file per task, versioned with the code. A person adds tasks; an agent only *proposes* one, and the proposal is a question in your inbox until you add it or drop it. Nothing becomes work without your "Add".

```bash
metator issue add "ADR for rounding" --body "Half-up or half-even." --priority high --labels adr,billing --by maciej
metator issue list                      # proposals first, then in progress, then open by priority; --status open, --run <id>
metator issue show i001
metator issue start i001 --workflow mt-feature     # a run on the task, in a new worktree; --no-worktree
metator issue close i001 --by maciej    # done
metator issue drop i002 --by maciej     # not a task after all
```

```json
{"kind":"Issue","schemaVersion":1,"id":"i002","title":"Negative amounts in round2","body":"half-down for negatives",
 "status":"proposed","priority":"normal","labels":[],
 "refs":[{"file":"src/invoice.ts","line":10},{"run":"20261109-feature-discount","step":"S2"}],
 "proposedBy":{"agent":"mt-implementer-1","runId":"20261109-feature-discount","at":"…","questionId":"q003"},
 "createdAt":"…","updatedAt":"…"}
```

## An agent proposes, you decide

A worker that notices something out of its task (a flaky test, a missing edge case, an ADR to write) runs `metator issue propose "<title>" --body … --ref src/invoice.ts:10 --ref run:<id>/S2 --agent <its name> --run <its run>`. The issue is written as `proposed` and the run gets a question, in your inbox with the agent's name: **Add to the backlog**, **Add and start a run**, or **Drop**. Your answer there is the decision; `metator issue decide i002 --add|--drop --by <name>` is the same decision from the CLI. A proposal cannot be started before it is decided. Every issue says who decided it (`decidedBy`), and where it came from (`proposedBy`, `refs`).

`issues.proposeFromAgents: false` in the repository's options switches proposals off: the agent is told to say it in its summary instead. Agents never add, edit, close or drop a task; those commands ask `--by <name>`.

## Starting a run on a task

`metator issue start i001 --workflow <id>` makes a run whose task is the issue's title and body, in a new worktree (so a new tab on the workbench); the issue becomes `in-progress` and remembers the run (`runId`), and `metator issue list --run <id>` shows the tasks of a run (started from it, proposed in it, or pointing at it).

## In the app

The **Backlog** screen (`#/backlog`; on the workbench `prefix+b` or *Backlog…* in a tab's menu) lists the agents' proposals, then the open tasks, with the finished ones folded at the bottom; the chosen task on the right shows its text, priority, labels, what it points at, the run it started, and the decision: **Add**, **Add and start a run**, **Drop** for a proposal; **Start a run**, **Done**, **Drop** for an open task. `+ task` adds one; *New task from here…* in a pane's menu opens the form pointing at that pane's run.

## Next

- [Inbox and decisions](./inbox.md): where a proposal waits for you.
- [The plan of a run](./plan.md): the run a task starts.
