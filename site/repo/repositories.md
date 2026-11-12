# Several repositories

MetatorAI is set up per repository. When you work on several, each keeps its own setup, and the folder that holds them can show all of their work in one place. With a single repository you do not need this page.

## Set up each repository

```text
~/work/
├── shop/
├── billing/
└── web/
```

```bash
cd ~/work/shop    && metator setup
cd ~/work/billing && metator setup
cd ~/work/web     && metator setup
```

Each repository then has its own `metator.config.yml`, agents, skills, hooks, workflows, runs and worktrees. Nothing in one repository changes another.

## Which repository a command acts on

A command acts on the nearest folder above your working directory that contains `.git`. So `cd ~/work/billing/src && metator run status` works on `billing`. From anywhere else, name the repository with `-C`:

```bash
metator -C ~/work/billing env status
```

## Repositories on one machine

MetatorAI keeps repositories apart where they share the machine:

| Shared resource | How it is kept apart |
|---|---|
| Ports of worktrees | each worktree leases a block of ports from one registry for the whole machine, so two repositories never get the same block |
| Docker Compose | each repository and place gets its own Compose project name (`metator-<repo>-<hash>-<place>`) |
| Agents and hooks | host files (`.claude/`, `.github/`) live in each repository and apply only there |

The machine-wide state lives in `$METATOR_STATE_DIR`, else `$XDG_STATE_HOME/metator`, else `~/.local/state/metator`.

One thing is not kept apart. A `shared` service keeps the port you wrote in `metator/environment.yml` (see [Run the application](./environments.md)). If two repositories each start their own shared Postgres on `5432`, the second cannot start. Give them different ports.

## A folder of repositories

Run `metator` in the folder that holds the repositories to see all of them at once:

```bash
cd ~/work
metator repos list       # each repository and whether MetatorAI is set up in it
metator repos status     # each repository's active runs, questions waiting for you, running services
metator ui               # every repository's runs on one screen
```

A folder that is not a repository but holds repositories works this way without any file. To fix the list and the names, write one:

```bash
metator repos init       # writes metator.repos.yml from the repositories below; never overwrites
```

```yaml
# ~/work/metator.repos.yml
kind: RepoSet
schemaVersion: 1
repos:
  - path: shop
  - path: billing
  - path: services/mailer
    name: mailer          # optional: how it is shown
```

The folder file is only a list. It holds no agents, rules or workflows, and changing it never touches a repository.

## What runs in the folder

| Where you are | What `metator` acts on | Commands |
|---|---|---|
| inside a repository, at any depth | that repository | every command |
| the folder of repositories | all its repositories | `ui`, `repos`, `ask`, `status` |
| anywhere, with `-C <path>` | the repository or folder at `<path>` | as above, for that place |

Any other command in the folder stops with a `USAGE` error that names the repositories. Run it inside one, or pass `-C`:

```bash
metator -C shop run init --workflow mt-feature --task "Add discount"
```

For questions across the folder see [Ask about the code](../use/ask.md). For sessions see [Sessions and worktrees](../use/sessions.md).

## Folder or system map

The folder says where checkouts are on your disk. It knows nothing about how the applications relate. If they call each other through APIs and a change in one can break another, describe that in a system map: see [Systems of applications](./systems.md).
