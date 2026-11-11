# Glossary

The terms this site uses, in alphabetical order.

| Term | Meaning |
|---|---|
| Agent | a role with one job (plan, implement, review), defined in `metator/agents/` and generated for each host |
| Answer policy | a saved answer to a question that repeats, created with `metator run answer ... --always` |
| Approval | a person's decision at a gate, recorded with who gave it and when |
| Artifact | a file a stage must produce in the run's folder, such as `plan.json` or `verdict.json` |
| Attach | taking the keyboard of a session's terminal; the agent waits until you release it |
| Autonomy level | how many gates ask a person: `L0` all of them, `L1` skips the gates a workflow marks `skipAt`, `L2` runs headless; a push always asks |
| Backlog | the repository's list of tasks; agents propose tasks and a person adds them |
| Canon | the knowledge about the repository that agents load: rules, patterns, module cards, decisions, lessons, agents and skills |
| Capability | what an agent may do (`read`, `edit`, `metator:graph`); it becomes the host's tool allowlist |
| Citation | a quote of the code with its `path:line`, checked against the code by `metator memory validate` |
| Conductor | the agent session that leads a run started with `metator run start` and hands work to workers in their own panes |
| Contract | an interface one application provides and others consume, such as an OpenAPI specification |
| Coordinator | an agent that leads a workflow and delegates; it never edits code |
| Daemon | the local process started by `metator serve` that holds the terminals, the inbox and the desktop app's data |
| Drive | `metator run drive`: moves a run stage by stage and asks a person when a gate needs one |
| E1, E2, E3 | how a rule is enforced: by a tool, by review, or as guidance only |
| Escalated | the state of a run that reached a loop limit or was aborted by its agent; a person takes over |
| Exemplar | an existing `file:line` in your code that new code must follow |
| Finding | one claim of a review, with a quote from the code, a trigger and the path by which it is reached |
| Gate | a point in a run that opens only on a passing check, a critic's verdict or a person's approval; also a named list of checks (`metator gate quick`) |
| Guard | the `metator guard ...` commands a host runs as hooks |
| Hook | a command the host runs at a fixed moment of a session, such as before a tool call |
| Host | the AI tool that runs the agents: GitHub Copilot or Claude Code |
| Inbox | the list of every question that waits for you, across runs |
| Intake | rules that turn issues from GitHub, GitLab or Jira into tasks and runs |
| Lens | a review agent with one focus: logic, contracts, conventions, tests, security or equivalence |
| Lesson | a short note of what a run taught, saved in `docs/metator/lessons/` after a person approves it |
| Memory map | `docs/metator/memory-map.yml`: every knowledge file with its tier, readers, writers and size budget |
| Module card | a page per package: facts generated from the code plus the notes you write |
| Pane | one terminal in the desktop app or under the daemon: an agent's session or a shell |
| Pattern | how the codebase solves a recurring problem, with an exemplar |
| Rule | a statement about the code with an id, a rationale and an enforcement level |
| Run | one task carried through a workflow, with its state in `.metator/runs/<id>/` |
| Session | a run together with its worktree, its ports and its terminal |
| Shard | one part of a change, by package, that a lens reviews |
| Skill | a procedure an agent loads when a task matches it, defined in `metator/skills/` |
| Stage | one step of a workflow; it ends with an event such as pass, fail or approve |
| Supervisor | the part of the daemon that restarts dead sessions, nudges idle ones and limits how many wait for you |
| System map | `docs/metator/system.yml`: the applications of a system, their contracts and who consumes them |
| Tier | for an agent: the class of model it runs on (`reasoning`, `standard`, `fast`); for a knowledge file: when it is loaded (`T0` to `T5`) |
| Verifier | the agent that tries to refute a blocking finding before it may block |
| Versioned document | any file MetatorAI reads or writes; it starts with `kind` and `schemaVersion` |
| Worker | an agent that does one stage or one task and writes one artifact |
| Workflow | the specification a run follows: stages, gates and loop limits, for example `mt-feature` |
| Worktree | a git worktree with its own branch and ports, where a run works apart from your checkout |
