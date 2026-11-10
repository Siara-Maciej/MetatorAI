# The plan of a run

**What for:** one look at where a run stands and what is left, without reading its log: the workflow's stages with who worked them and when, the plan's steps with their live state, who works on what, what waits for you, what the run has produced, and what comes next. Nothing on it is written by a model; everything is computed from the run's own files when you ask.

```bash
metator run board                 # the latest run; --run <id> for one; --timeline 50 for more events
```

```json
{"runId":"20261109-feature-discount","stage":"build","status":"active",
 "stages":[{"id":"plan","state":"done","owners":["mt-planner"],"workedBy":["mt-planner"],"startedAt":"…","endedAt":"…","verdict":"PASS"},
           {"id":"approval","state":"done","hitl":true,"verdict":"APPROVE"},
           {"id":"build","state":"current","owners":["mt-test-author","mt-implementer"],"workedBy":["mt-implementer"]}],
 "plan":{"done":1,"steps":[{"id":"S1","path":"src/invoice.test.ts","state":"done","worker":{"name":"mt-test-author-1","paneId":"w1:p3"},"evidence":"mt-test-author-1: 3 tests, red for the right reason"},
                           {"id":"S2","path":"src/invoice.ts","state":"in-progress","worker":{"name":"mt-implementer-1","paneId":"w1:p2"},"evidence":"Edit src/invoice.ts"}]},
 "waiting":[{"id":"q001","source":"permission","prompt":"Allow bun test?"}],
 "artifacts":[{"name":"plan.json","present":true,"stage":"plan"},{"name":"build-log.md","present":false,"stage":"build"}],
 "gates":[{"gate":"quick","passed":true,"steps":[{"id":"lint","ok":true}]}],
 "next":[{"id":"review","owners":["mt-pr-review"]}]}
```

## Where each fact comes from

| On the board | From |
|---|---|
| a stage's state, who worked it, when, its verdict | the run record's history and the activity (`stage` and `agent` entries, `PASS`, `APPROVE`) |
| a step `done` | a worker's `WorkerResult` with `status: done` that names the step's file (or its id) in `artifacts` or in its summary |
| a step `in-progress` | a tool call on the step's file in the activity (the hooks record every edit); failing that, the first step not done while a worker of the stage is alive |
| a step `blocked` | a worker's result with `blocked` or `failed` that names the step |
| what waits for you | the open questions, the oldest first |
| artifacts | the run directory: what the stages declare in `produces`, the usual files (`task.md`, `plan.json`, `verdict.json`, …), and what is there |
| gates | `.metator/gates/quick.json` and `full.json` |

## In the app

The **Plan** screen (`#/plan/<run>`; on the workbench `prefix+p`, a click on the stages under the tabs, or a pane's menu) shows the steps on the left, one step on the right (its file, tests first, exemplar, rules, what it follows), the question that waits for you at the top with its answers (a host's permission prompt is answered in the pane: *Answer in the pane* takes the keyboard), what comes next, the artifacts, the workers with their panes, and the last events. *Show the pane* jumps to the worker's pane on the workbench.

## Next

- [Terminals, panes and the conductor](./terminals.md): the panes the board points at.
- [Inbox and decisions](./inbox.md): the questions the board lists.
