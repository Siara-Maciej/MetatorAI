# Reference

Look things up here: a command and its options, a configuration key, a file MetatorAI writes, the meaning of an error.

| Page | What it holds |
|---|---|
| [Command reference](./commands.md) | every command with its arguments, options and defaults, generated from the CLI |
| [Output and exit codes](./cli.md) | the JSON every command prints, error codes, exit codes, environment variables |
| [Configuration](./configuration.md) | `metator.config.yml` and the options you set per user, repository or run |
| [Documents and schemas](./documents.md) | every file MetatorAI reads or writes, where it lives and who writes it |
| [Hooks protocol](./hooks.md) | what `metator guard` reads from the host and what it answers |
| [Daemon HTTP API](./http.md) | the routes of `metator serve` that the app and scripts call |
| [MCP server](./mcp.md) | MetatorAI's reading commands as MCP tools for other agents |
| [Ports and plugins](./extending.md) | how a tool is connected, for contributors |
| [Security](./security.md) | what is enforced by code, the audit trail, where data goes |
| [Troubleshooting](./troubleshooting.md) | common errors and their fixes |
| [Glossary](./glossary.md) | the terms this site uses |
| [Changelog](./changelog.md) | what changed, newest first |

## Commands you type

The CLI has more than two hundred commands. Most of them are called by agents, hooks and CI. These are the ones a person types. `metator help --verbs` prints a similar list in the terminal.

### Set up a repository

| Command | What it does |
|---|---|
| [`metator setup`](./commands.md#metator-setup) | writes the configuration, installs agents, skills and workflows, generates the host files, checks the result |
| [`metator doctor`](./commands.md#metator-doctor) | lists what a run cannot do here and the fix for each |
| [`metator agents update`](./commands.md#metator-agents-update) | takes a newer version of the shipped agents and skills and keeps the files you changed |
| [`metator config list`](./commands.md#metator-config-list) | every option with its value and the file that sets it |

### Work on a task

| Command | What it does |
|---|---|
| [`metator quick start`](./commands.md#metator-quick-start) | a small change without a plan: build, the quick gate, one short review; it ends with a diff to look at |
| [`metator run`](./commands.md#run) | starts a full run in the terminal: you pick the workflow, the task and the host, then follow it |
| [`metator issue list`](./commands.md#metator-issue-list) | the backlog: proposals from agents that wait for you, then the open tasks |
| [`metator issue start`](./commands.md#metator-issue-start) | starts a run on a task of the backlog, in a new worktree |
| [`metator inbox`](./commands.md#metator-inbox) | every question that waits for you, across runs |
| [`metator run answer`](./commands.md#metator-run-answer) | answers a question so the run continues |
| [`metator status`](./commands.md#metator-status) | every run: its stage, who must act, open questions |
| [`metator attach`](./commands.md#metator-attach) | puts your terminal on a session's pane; Ctrl-] detaches |

### Read and check a change

| Command | What it does |
|---|---|
| [`metator review changes`](./commands.md#metator-review-changes) | what a run changed, file by file |
| [`metator open`](./commands.md#metator-open) | opens your editor on the run's worktree |
| [`metator gate`](./commands.md#metator-gate) | runs the repository's checks: `metator gate quick` or `metator gate full` |
| [`metator meta check-all`](./commands.md#metator-meta-check-all) | checks rules, knowledge, agents, skills, workflows and generated files in one pass |
| [`metator ask`](./commands.md#ask) | answers a question about the code with `path:line` citations |

### Many repositories

| Command | What it does |
|---|---|
| [`metator repos init`](./commands.md#metator-repos-init) | writes `metator.repos.yml` in a folder from the repositories below it |
| [`metator repos list`](./commands.md#metator-repos-list) | the folder's repositories, whether each is set up, and their worktrees |
| [`metator system plan new`](./commands.md#metator-system-plan-new) | drafts a plan for a change across applications |

### Keep work coming in

| Command | What it does |
|---|---|
| [`metator serve`](./commands.md#metator-serve) | the local daemon behind the desktop app, the inbox and the terminals |
| [`metator intake scan`](./commands.md#metator-intake-scan) | turns new issues from GitHub, GitLab or Jira into tasks and runs, by your intake rules |
| [`metator mrs list`](./commands.md#metator-mrs-list) | reviews of your open pull requests, with proposed replies |

Each of these has a how-to page: [Start with one repository](../guide/first-run.md), [Start with many repositories](../guide/many.md), [Chats and the three ways](../use/start.md), [Home and the Board](../use/inbox.md).
