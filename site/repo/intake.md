# Automatic intake

Intake turns issues from GitHub, GitLab or Jira into tasks in your backlog and into runs, without anyone typing them in. You write rules that say where to look, what to take, which workflow runs it and how far the run goes without you.

## Connect the source

Intake reads the sources listed in `codehost.sources`, the same list [Reviews](../use/reviews.md#configure-the-sources) use. Each source says what it is and which tool reads it. Intake reads a source through an MCP server, `via: "mcp:<name>"` for a server under `mcp:`; a source read by `gh` serves reviews only, and intake reads its kind through the MCP server of that name (`github`).

```yaml
# metator.config.yml
mcp:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
  jira:
    command: jira-mcp
codehost:
  sources:
    - { id: shop, kind: github, repo: acme/shop, via: "mcp:github" }
    - { id: jira-shop, kind: jira, project: SHOP, via: "mcp:jira" }
```

A server has a `command` (with `args`) or a `url`. In `env`, write `${VAR}` and keep the token in your environment. The file is then safe to commit.

::: warning
Do not put a token itself into `metator.config.yml`. The file is committed, and `metator generate` copies the `mcp:` entries into `.mcp.json`.
:::

```bash
metator generate     # writes the servers into .mcp.json, which Claude Code and the Copilot CLI read
metator doctor       # warns when a server's command is not on your PATH
```

`metator generate` sets your servers by name and keeps other entries of `.mcp.json` as they are. A server you remove from the configuration stays in `.mcp.json` until you remove it there.

## Write rules

A rule names its source by id, and says what to take from it and which workflow runs it:

```yaml
intake:
  everyMs: 120000
  maxActive: 2
  rules:
    - id: gh-bugs
      source: shop
      labels: [bug]
      workflow: mt-bugfix
    - id: jira-tasks
      source: jira-shop
      type: Task
      workflow: mt-feature
      autonomy: full
```

| Key | Default | Meaning |
|---|---|---|
| `everyMs` | `120000` | how often the daemon scans, in milliseconds |
| `maxActive` | `2` | how many runs started by intake may be active at once |
| `rules[].id` | | lowercase letters, digits and dashes; unique |
| `rules[].source` | | the id of a source in `codehost.sources` |
| `rules[].labels` | `[]` | take only items with these labels |
| `rules[].state` | `open` | the item state to list |
| `rules[].type` | | the Jira issue type, for example `Bug` |
| `rules[].tool` | the kind's usual tool | the server's tool that lists items |
| `rules[].workflow` | | the workflow a new item starts |
| `rules[].autonomy` | `gated` | `gated`: every gate of the workflow asks you. `full`: gates the workflow marks as skippable pass; a push still asks |
| `rules[].worktree` | `true` | the run works in its own worktree |

A configuration of version 14 or older, with the source written inside the rule, still loads: its sources move to `codehost.sources` and the rules name them by id.

Check what MetatorAI read from your file:

```bash
metator intake rules
```

Without rules it prints the defaults:

```json
{"ok":true,"data":{"everyMs":120000,"maxActive":2,"rules":[]}}
```

## Scan

```bash
metator intake scan --dry-run    # what is new at the sources; nothing is written or started
metator intake scan              # one pass: new items become tasks and runs
metator intake scan --drive      # also drive each started run in the background
```

A scan goes through every rule. Each item the backlog does not hold yet becomes a task, and the task starts a run under the rule's workflow. For each rule the report gives how many items the source listed, how many were already known, which are new, which runs started, and which tasks wait.

- An item becomes a task once. The task remembers its source by a key, such as `github:acme/shop#12` or `jira:SHOP-7`, so a later scan does not add it again.
- A run that intake starts in a worktree starts from the last commit, also when tracked files in your checkout have uncommitted changes. Nobody is there to commit or stash them, and a run from an issue does not need them.
- When `maxActive` runs are already active, the remaining tasks stay open in the backlog. A later scan starts them, before newer items.
- The reporter's text is quoted in the task, with where it came from. Agents treat it as data and do not follow instructions in it.
- A source that cannot be read gives a warning for its rule. The other rules are scanned as usual.
- Intake only reads the source. It changes nothing there.

## Let the daemon scan

```bash
metator serve
```

The daemon scans every `everyMs` and drives the runs it starts. `--intake-ms <n>` sets another interval, and `--intake-ms 0` turns scanning off. In a folder of repositories, the daemon scans each repository that has rules.

## See what intake holds

```bash
metator intake status
```

It lists intake's tasks with their source key, rule, status and run, and counts them by rule and status. The tasks are also in the backlog ([Plan and backlog](../use/plan.md#backlog)).

## How far a run goes alone

With `autonomy: gated`, a run stops at its first gate and the decision waits on [Home](../use/inbox.md). With `full`, the run starts at autonomy `L1`: gates that the workflow lets `L1` skip, such as the plan approval, pass and are logged as such. The delivery gate always asks, so nothing is pushed without you. See [Approvals and consent](../use/approvals.md#autonomy).
