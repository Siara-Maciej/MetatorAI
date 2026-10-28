# Several repositories

You work on more than one repository. There are two ways to set MetatorAI up for that, and you can mix them.

| You want | Set up | Run `metator` |
|---|---|---|
| each repository on its own, independent of the others | `metator setup` **in each repository** | **inside the repository** you work on (or `metator -C <repo> …` from anywhere) |
| one view over several repositories in a folder | each repository as above, plus a folder file (see [A folder of repositories](#a-folder-of-repositories)) | inside a repository for its work; in the folder for the view over all of them |

## Each repository on its own

```text
~/work/
├── shop/        ← git repository, `metator setup` here
├── billing/     ← git repository, `metator setup` here
└── web/         ← git repository, `metator setup` here
```

```bash
cd ~/work/shop    && metator setup
cd ~/work/billing && metator setup
cd ~/work/web     && metator setup
```

Each repository then has its own MetatorAI:
- its own `metator.config.yml`, agents, skills, hooks and workflows;
- its own runs (`.metator/runs`), worktrees (`.metator/wt`) and environment (`metator/environment.yml`).

Nothing in one repository changes another.

**Which repository a command acts on:** the nearest folder above where you run it that contains `.git` (or a `metator.config.*`). So `cd ~/work/billing/src && metator run …` works on `billing`. From anywhere else, name the repository:

```bash
metator -C ~/work/billing env status
```

### They never collide on one machine

| Shared resource | How MetatorAI keeps repositories apart |
|---|---|
| Ports of worktrees | Each worktree leases a block of ports from one registry for the whole machine (`PortLeases`, in `~/.local/state/metator`), so two repositories never get the same block. A lease whose worktree is gone holds nothing. |
| Docker Compose | Every repository and place gets its own Compose project, e.g. `metator-shop-1a2b3c-shared`, so containers of two repositories never mix. |
| Process logs | A log directory per repository. |
| Agents and hooks | Host files (`.claude/`, `.github/`) live in each repository and apply to that repository only. |

::: warning Fixed ports of shared services
A `shared` service keeps the port you wrote in `metator/environment.yml` (for example Postgres on `5432`). If two repositories each start their own shared Postgres on `5432`, the second cannot start. Give them different ports, or let one repository's database serve both.
:::

The machine-wide state directory is `$METATOR_STATE_DIR`, else `$XDG_STATE_HOME/metator`, else `~/.local/state/metator`.

## A folder of repositories

Each repository keeps its own MetatorAI, as above. The folder that holds them can also be a place to run `metator`: there it covers all of its repositories at once.

```text
~/work/
├── metator.repos.yml    ← optional: which repositories the folder holds
├── shop/
├── billing/
└── services/mailer/
```

```bash
cd ~/work
metator repos init       # writes metator.repos.yml from the repositories below (two levels deep)
metator repos list       # each repository and whether MetatorAI is set up in it
metator repos status     # each repository's active runs, questions waiting for you, running services
metator ui               # pick a repository, work in its sessions, come back for the next one
```

```yaml
# ~/work/metator.repos.yml
kind: RepoSet
schemaVersion: 1
repos:
  - path: shop
  - path: billing
  - path: services/mailer
    name: mailer          # optional: how it is shown (default: the last part of the path)
```

Without `metator.repos.yml`, a folder that is not a repository itself but holds repositories works the same way; the file only fixes the list and the names.

### Where to run what

| Where you are | What `metator` acts on | What runs there |
|---|---|---|
| inside a repository, at any depth (`~/work/shop/src`) | that repository: the nearest `.git` wins, even inside a folder of repositories | every command |
| the folder (`~/work`), or a folder below it that is not a repository | all repositories of the folder | `ui`, `repos init\|list\|status`, [`ask`](../workflows/ask.md), [`status`](../workflows/sessions.md#the-work-at-a-glance) |
| anywhere, with `-C <path>` | the repository or folder at `<path>` | as above, for that place |

Any other command in the folder stops with a pointer instead of guessing:

```bash
cd ~/work && metator run init --workflow mt-feature --task "Add discount"
```

```json
{"ok":false,"error":{"code":"USAGE",
 "message":"`metator run init` works on one repository, and /home/me/work is a folder of 3",
 "hint":"Run it inside a repository (billing, mailer, shop) or pass `-C <repository>`; here, `metator ui`, `repos`, `ask` and `status` cover them all."}}
```

```bash
metator -C shop run init --workflow mt-feature --task "Add discount"    # from the folder
```

### The folder shares nothing

The folder is a list, not a configuration: it holds no agents, rules or workflows of its own, only `metator.repos.yml` and the conversations of questions asked there, and changing it never touches a repository. A [system map](./index.md) is the other way round: it describes what the applications are and how their contracts connect them, while the folder only says where their checkouts are on your disk.
