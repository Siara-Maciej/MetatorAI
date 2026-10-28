# @metator/plugin-host-scenario

`AgentHost` that plays an `AgentScenario` file instead of calling a model: `run drive --host scenario` with `METATOR_AGENT_SCENARIO=<file>`. It drives whole workflows in tests, demos and workflow CI.

- Steps run in order; `write` paths are relative to the agent's working directory unless they start with `{runDir}`.
- Pitfall: the n-th start of an agent plays its n-th entry, and the last entry repeats; a loop that comes back needs its own entry.
