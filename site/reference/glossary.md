# Glossary

| Term | Meaning |
|---|---|
| **Artifact** | a file a stage must produce (`plan.json`, `findings/*.json`), always a versioned document; a stage is done when its artifact validates |
| **Attach** *(planned)* | taking the keyboard of a session's terminal; the agent's drive pauses and chat approvals count until you release |
| **Autonomy level** | `L0` every gate asks, `L1` autopilot passes gates marked `skipAt`, `L2` headless; push and comments always ask |
| **Canon** | the repository's knowledge agents load: rules, patterns, module cards, ADRs, lessons, memory map, agents and skills |
| **Capability** | what an agent may do (`read`, `metator:graph`); becomes a tool allowlist on the host |
| **Citation** | `[[cite: path:line \| "quote"]]`, a quote checked against the code by `memory validate` |
| **Coordinator** | an agent that runs a workflow and delegates (`mt-orchestrator`, `mt-pr-review`); it never edits code |
| **Decision card** *(planned)* | an inbox item assembled from the run's files: context, proposal, evidence, options, recommendation |
| **Driver** *(planned)* | who controls a session's terminal: the agent, or a person who attached |
| **E1, E2, E3** | enforcement levels of a rule: a tool decides, review lenses check, guidance only |
| **Envelope** | the one JSON object every command prints: `{"ok":true,"data":…}` or `{"ok":false,"error":…}` |
| **Escalation** | a run that reached a loop limit or whose agent is blocked; it stops and waits for a person |
| **Exemplar** | an existing `file:line` in your code that a new file must follow; `plan lint` requires one |
| **Finding** | a review claim with a quote, a trigger and a reachability path; verified before it may block |
| **Gate** | a point in a run opened only by a passing check, a critic's verdict or a person's approval |
| **Group** *(planned)* | a parent run with children in order, one per application; shown as one tree |
| **Guard** | the `metator guard …` commands hosts run as hooks: `pre-tool`, `post-edit`, `stop`, `subagent-output`, `session-start`, `precompact` |
| **Host** | the AI tool that runs the agents: GitHub Copilot, Claude Code, OpenCode |
| **Inbox** *(planned)* | the queue of every question, permission and gate waiting for you, across sessions and repositories |
| **Lens** | a review agent with one focus: logic, contracts, conventions, tests, security, equivalence |
| **Memory map** | `docs/metator/memory-map.yml`: every knowledge file, its tier, readers, writers and budget |
| **Module card** | per package: a generated block from the graph plus curated responsibility, invariants and pitfalls |
| **Pattern** | how the codebase solves a recurring problem, detected by ast-grep, with an exemplar |
| **Policy** *(planned)* | a learned answer to a repeating permission, recorded in `metator.config.yml` |
| **Run** | one task as a state machine in `.metator/runs/<id>/` |
| **Session** | a run with a worktree, ports, a terminal, a driver and a supervisor |
| **Shard** | one part of a diff, by package, that a lens reviews with that package's card and rules |
| **Supervisor** *(planned)* | keeps sessions alive: restarts with resume, nudges idle sessions, enforces the attention limit |
| **T0 … T5** | memory tiers: always loaded, loaded per file, indexes, the run, lessons, history |
| **Verifier** | an agent on another model that tries to refute a blocking finding with a test |
| **Versioned document** | any file MetatorAI reads or writes: `kind` + `schemaVersion` first, migrated on read |
| **Worker** | an agent that does one stage and writes one artifact |
| **Workflow** | the YAML spec a run follows, checked by `workflow lint` against a 16-section anatomy |
| **Worktree** | a git worktree with its own branch and port block, where a run works |
