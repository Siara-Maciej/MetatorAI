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
| Board | the place of the app that shows every task by phase: To do, Planning, In progress, Review, Done |
| Canon | the knowledge about the repository that agents load: rules, patterns, module cards, decisions, lessons, agents and skills |
| Capability | what an agent may do (`read`, `edit`, `metator:graph`); it becomes the host's tool allowlist |
| Chat | one topic you talk about with the conversation agent, `mt-chat`, in a terminal of the app; its record is a thread |
| Citation | a quote of the code with its `path:line`, checked against the code by `metator memory validate` |
| Conductor | the agent session that leads a run started with `metator run start` and hands work to workers in their own panes |
| Consent | your yes to one `git commit`, `push`, `merge` or `rebase` an agent wants to run: a click on its card, your own words in the chat, or a run's approved delivery |
| Contract | an interface one application provides and others consume, such as an OpenAPI specification |
| Coordinator | an agent that leads a workflow and delegates; it never edits code |
| Daemon | the local process started by `metator serve` that holds the terminals, the inbox and the desktop app's data |
| Debug change | an edit not meant for a commit, recorded with `metator scratch` so it can be taken out again and no commit takes it |
| Direct, quick, full | the three ways a chat suggests: answer or edit at once; a small change without a plan; a workflow with a plan and approvals |
| Drive | `metator run drive`: moves a run stage by stage and asks a person when a gate needs one |
| E1, E2, E3 | how a rule is enforced: by a tool, by review, or as guidance only |
| Escalated | the state of a run that reached a loop limit or was aborted by its agent; a person takes over |
| Exemplar | an existing `file:line` in your code that new code must follow |
| Finding | one claim of a review, with a quote from the code, a trigger and the path by which it is reached |
| Folder of repositories | a directory that holds several repositories, listed in `metator.repos.yml` (RepoSet); one daemon serves all of them |
| Gate | a point in a run that opens only on a passing check, a critic's verdict or a person's approval; also a named list of checks (`metator gate quick`) |
| Guard | the `metator guard ...` commands a host runs as hooks |
| Guard levels | `never`, `ask` and `allow`: how the guard treats a shell command of `guard.commands` |
| Home | the first screen of the app: every decision that waits for you, one at a time |
| Hook | a command the host runs at a fixed moment of a session, such as before a tool call |
| Host | the AI tool that runs the agents: Claude Code (`claude`) or GitHub Copilot CLI (`copilot`) |
| Inbox | the queue of every question that waits for you, across runs (`metator inbox`); **Home** in the app shows it one decision at a time |
| Intake | rules that turn issues from GitHub, GitLab or Jira into tasks and runs |
| Lens | a review agent with one focus: logic, contracts, conventions, tests, security or equivalence |
| Lesson | a short note of what a run taught, saved in `docs/metator/lessons/` after a person approves it |
| Memory map | `docs/metator/memory-map.yml`: every knowledge file with its tier, readers, writers and size budget |
| Module card | a page per package: facts generated from the code plus the notes you write |
| Pane | one terminal in the desktop app or under the daemon: an agent's session or a shell |
| Pattern | how the codebase solves a recurring problem, with an exemplar |
| Quick change | a run of `mt-quick`: build, the quick gate, one short review, ending with an uncommitted diff; allowed only when `metator quick check` finds no escalator |
| Rule | a statement about the code with an id, a rationale and an enforcement level |
| Run | one task carried through a workflow, with its state in `.metator/runs/<id>/` |
| Session | an agent's conversation in a terminal of its host: a chat, a run's conductor or a worker |
| Shard | one part of a change, by package, that a lens reviews |
| Skill | a procedure an agent loads when a task matches it, defined in `metator/skills/` |
| Stage | one step of a workflow; it ends with an event such as pass, fail or approve |
| Step | one part of a system plan, carried out by a run in one application's repository; also one entry of a run's plan |
| Supervisor | the part of the daemon that restarts dead sessions, nudges idle ones and limits how many wait for you |
| System map | `docs/metator/system.yml`: the applications of a system, their contracts and who consumes them |
| System plan | the steps of a change across applications, per application and in deploy order, approved by a person |
| Task | what the sidebar lists under a chat: a run with everything it started; on the Backlog, an item to do later |
| Thread | the record of a chat in `.metator/threads/`: title, summary, its runs and facts; the agent reads it when a session of the chat starts |
| Tier | for an agent: the class of model it runs on (`reasoning`, `standard`, `fast`); for a knowledge file: when it is loaded (`T0` to `T5`) |
| Verifier | the agent that tries to refute a blocking finding before it may block |
| Versioned document | any file MetatorAI reads or writes; it starts with `kind` and `schemaVersion` |
| Watched review | a pull request MetatorAI reviewed or was asked to review, followed for new commits and replies |
| Worker | an agent that does one stage or one task and writes one artifact |
| Workflow | the specification a run follows: stages, gates and loop limits, for example `mt-feature` |
| Worktree | a git worktree with its own branch and ports, where a run works apart from your checkout |
