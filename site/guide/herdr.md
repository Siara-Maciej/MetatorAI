# herdr with MetatorAI's guard

[herdr](https://herdr.dev) runs your agents' terminals: workspaces, tabs and panes that keep running when you close the window, remote machines, and a sidebar that shows which agent is working, blocked or idle. MetatorAI runs on top of it as the guard layer: workflows, gates, the driver lock, the decision inbox, and hooks that refuse unsafe tool calls (ADR-0079).

herdr lets any process in any pane drive any other pane. MetatorAI's hooks close that gap for agents: an agent cannot answer another agent's approval prompt, start agents outside a run, or plant a command herdr runs after a restart.

## Set up

```bash
metator setup                                   # agents, skills and the guard hooks for your hosts
herdr plugin link "$METATORAI/integrations/herdr"   # the MetatorAI plugin for herdr
herdr                                           # start herdr where the work lives
```

`metator` must be on `PATH` for the plugin. `METATOR_HERDR_BIN` points MetatorAI at another herdr binary; `HERDR_SESSION` selects a named herdr session.

## Run a session in herdr

```bash
metator run init --workflow mt-feature --task "Add the due date to the invoice" --worktree
metator herdr open --host claude          # a herdr workspace for the run, the host started in it
metator herdr sync --watch                # the run's stage in herdr's sidebar, host prompts in the run
metator herdr close                       # ends the workspace and its processes
```

`herdr open` creates one herdr workspace per run, labelled with the run id, in the run's worktree. It starts the host with the run's flags (`copilot -i … --deny-tool "shell(git push)"`, `claude … --session-id …`, `opencode … --prompt …`) and the variables `METATOR_RUN`, `METATOR_RUN_DIR` and `METATOR_DRIVEN=1`, so the host's hooks guard every tool call of that run. Opening again finds the same pane; when the pane is gone, the host resumes its session in a new one. The default host is the first of `supervisor.hostOrder`.

`herdr sync` writes `stage · who must act` to the run's pane in herdr's sidebar, and notes in the run's activity when herdr sees the host stopped at a prompt of its own that is not a MetatorAI question. Answer such a prompt in herdr yourself.

## The plugin

| In herdr | Does |
|---|---|
| action **MetatorAI: attach me** | `metator run attach --by $USER` for the run of the current workspace: you drive it, and a yes you say in the chat counts as an approval |
| action **MetatorAI: release to the agent** | `metator run release` |
| action **MetatorAI: sync run state** | `metator herdr sync` |
| pane **MetatorAI inbox** | `metator ui` over the run's repository: every open decision with its card |
| event `pane.agent_status_changed` | `metator herdr sync`, so the run notes host prompts as herdr sees them |

The plugin finds the run from herdr's workspace id through `herdr-workspaces.json` in MetatorAI's machine state directory, written by `herdr open` and `herdr close`.

## What the guard refuses

Every `PreToolUse` hook of a MetatorAI agent, and the Claude SDK host in-process, refuses these shell commands, with or without a run:

| Refused | Why | Instead |
|---|---|---|
| `herdr agent send-keys`, `agent attach`, `pane send-text`, `send-keys`, `send-input`, `run`, `input`, `terminal attach`, `session attach` | typing into a pane can answer another agent's approval prompt | `metator run message <run> --text …` |
| `herdr agent prompt` | an instruction outside the other run | `metator run message` (data, never instructions) |
| `herdr agent start`, `metator herdr open` | agents start inside a run, by a person | `metator herdr open` from your shell |
| `herdr pane report-agent`, `report-agent-session`, `release-agent` | a resume command runs again after a restart | the host's own integration |
| `herdr plugin install` and friends, `integration install` | plugins run as you, with no sandbox | install them yourself |
| `herdr workspace close`, `tab close`, `pane close`, `worktree remove`, `server stop`, `session stop`, `metator herdr close` | ends work | ask the user |
| `--trust-repository` | git trust is the user's call | ask the user |
| `herdr machine add` and friends, `herdr update` | SSH machines and updates are yours | change them yourself |
| anything naming `HERDR_SOCKET_PATH` or `herdr.sock` | the socket bypasses the CLI and these rules | `herdr` commands that read |

Reading (`list`, `get`, `read`, `wait`, `explain`), layout (`workspace create`, `pane split`) and `notification show` stay open.

The guard sees an agent's commands, not every process: an agent with a plain shell could still write a program that reaches the socket another way. Keep plain `Bash` for the agents that need it (implementers), as MetatorAI's agent definitions already do.

## Notifications

Point MetatorAI's question notifications at herdr:

```yaml
notify:
  command: herdr notification show "MetatorAI" --body "$METATOR_QUESTION_PROMPT" --sound request
```
