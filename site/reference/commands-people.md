# Commands for people

A handful of commands cover what a person does with MetatorAI. Everything else in the CLI is a tool for agents, hooks and scripts: the full list, generated from the CLI, is in the [Command reference](./commands.md).

| Command | What it does | Read more |
|---|---|---|
| `metator setup` | surveys the repository, writes `metator.config.yml`, installs the canon, generates the host files, checks the result | [Installation](../start/installation.md) |
| `metator run` | starts a run and drives it live: workflow, task, autonomy, host, worktree; `run continue` picks one up | [Sessions and terminals](../work/sessions.md) |
| `metator ask "…"` | a plain question about the code, answered with `path:line` citations | [Ask about the code](../work/ask.md) |
| `metator ui` | full screen: every session, what needs you, applications, settings | [Sessions and terminals](../work/sessions.md) |
| `metator status` | the same overview as JSON, for scripts | [Sessions and terminals](../work/sessions.md) |
| `metator gate full` | the repository's own checks, one report | [Quality gates and CI](../knowledge/gates-ci.md) |
| `metator meta check-all` | the canon's checks: agents, skills, workflows, rules, memory, docs | [Keep knowledge true](../knowledge/truth.md) |
| `metator meta quarterly` | the quarterly review: dead rules, budgets, stale docs, unpromoted lessons, eval regressions, as actions | [Keep knowledge true](../knowledge/truth.md#the-quarterly-review) |
| `metator agents update` | take a newer canon; files you changed are kept | [Agents and skills](../knowledge/agents.md) |

```bash
metator setup                                  # once per repository
metator run                                    # a new run, watched live
metator ask "How is the discount computed?"
metator ui
metator gate full && metator meta check-all    # what CI runs
```

A review is a workflow: in chat, `@mt-pr-review review PR #482`; from the terminal, `metator run` with the `mt-pr-review` workflow ([Review](../work/review.md)).

## Everything prints one JSON object

```json
{"ok":true,"data":{ ... }}
{"ok":false,"error":{"code":"CHECK_FAILED","message":"...","hint":"...","details":{ ... }}}
```

The `hint` says what to do next. Exit codes are stable: `0` ok, `1` a check failed or something was not found, `64` usage error, `65` stale index. See [CLI and envelope](./cli.md).

## For agents, hooks and scripts

The remaining commands are listed by group in the generated [Command reference](./commands.md): `run`, `workflow`, `gate`, `plan`, `rules`, `patterns`, `cards`, `memory`, `findings`, `review`, `eval`, `guard`, `worktree`, `env`, `system`, `arch` and the rest. Each entry gives its arguments, options and defaults, read from the CLI itself so it can never drift.
