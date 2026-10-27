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

Working inside each repository is all you need. A folder file is optional; it adds one view over several repositories, for `metator ui`, `metator ask` and `metator repos`. It is described in the next release step (G2) and this page will show it as soon as it ships.
