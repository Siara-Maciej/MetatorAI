# Start with many repositories

This page is for work that spans several repositories: you set each one up, start one daemon in the folder that holds them, and see the work of all of them in one place. Then, when your applications depend on each other, a change that crosses them becomes a system plan. Read [Start with one repository](./first-run.md) first: everything there holds inside each repository.

<WaySwitch />

## Set up each repository

```text
~/work/
├── shop/
├── billing/
└── web/
```

<Way app>

**Add repository…**, choose the folder `~/work`: the app finds the repositories in it and offers **Set up** for each one not set up yet, then adds the folder ([Add a repository](./desktop-app.md#add-a-repository)).

</Way>

<Way cli>

```bash
cd ~/work/shop    && metator setup
cd ~/work/billing && metator setup
cd ~/work/web     && metator setup
```

</Way>

Each repository keeps its own `metator.config.yml`, agents, hooks, workflows, runs and worktrees. Nothing in one changes another. Commit the result in each.

## Describe the folder

```bash
cd ~/work
metator repos init     # writes metator.repos.yml from the repositories below; never overwrites
metator repos list     # each repository, whether MetatorAI is set up in it, and its worktrees
```

```yaml
# ~/work/metator.repos.yml
kind: RepoSet
schemaVersion: 2
repos:
  - path: billing
  - path: shop
    worktrees:
      - shop-fix
  - path: web
```

The file is only a list: it holds no agents, rules or workflows. A folder works without it too; the file fixes the list and the names.

### Worktrees count under their repository

When you keep a second checkout of a repository next to it (`git worktree add ../shop-fix fix-tax`), MetatorAI counts it under its repository, not as another one. The folder above is three repositories, and `shop` lists `shop-fix` under `worktrees` with its branch. Each checkout keeps its own runs and chats, and the app shows them under `shop` as `shop (fix-tax)`. [Folder of repositories](../many/index.md#worktrees-in-the-folder) has the details.

## One daemon for the folder

<Way app>

The app starts it when it opens the folder.

</Way>

<Way cli>

```bash
cd ~/work
metator serve
```

</Way>

The daemon serves every repository of the folder, and each repository's own checks, intake and reviews still follow its own configuration. In the folder, `metator status`, `inbox`, `repos status` and `ask` cover every repository. Any other command works inside one repository, or with `-C <repository>`:

```bash
metator status                                  # every repository's runs, by repository
metator -C shop run new --workflow mt-feature --task "Add discount"
```

## The app on a folder

<Way cli>

In a terminal, `metator inbox` in the folder holds the questions of every repository in one queue, and `metator status` their runs. The rest of this section is the app's.

</Way>

Open the app as for one repository. The top bar shows the folder as **3 repositories**. Then:

- **Home** holds the decisions of every repository in one queue; a card's **Details** names its repository.
- **Terminals**, **Backlog**, **Reviews** and **Settings** show one repository at a time, with a **repository** select at the top. The choice is shared by these places and remembered. A worktree is one of the places to pick, as `shop (fix-tax)`.
- **+ New chat** opens the chat in the repository the select names. The agent works there, and before a full run it asks which repository the run belongs to when the code cannot tell.
- The page of a run always uses the run's own repository.

![Home on a folder of 2 repositories: Approve the plan for Show prices with tax in shop-web, with Approve, Reject and Other](../public/screens/real/real-09-system-plan-card.webp)
*On a folder, one Home holds the decisions of every repository.*

## Changes that cross applications

When your applications call each other through APIs, describe how they relate in a system map, `docs/metator/system.yml`, kept in one repository. MetatorAI can propose it from the code of the whole folder:

```bash
cd ~/work
metator system discover            # a proposal with its evidence
metator system discover --write    # write it into the repository that holds the map, when there is none
```

With a map, MetatorAI tells you which applications a change reaches and whether it breaks a consumer ([Systems of applications](../many/systems.md)). A change that crosses applications becomes a system plan: one step per application, in deploy order, each step a run in its own repository that opens as a session you can watch.

In a chat, ask for the change and the agent suggests `mt-system-change`. Or from the repository that holds the map:

```bash
metator -C shop system plan new "Rename refunds"   # a draft from the map's policies
metator -C shop system plan approve rename-refunds # you, never an agent
metator -C shop system plan run rename-refunds     # start the steps that can start
```

The task's page in the app draws the plan as a flow, a lane per repository, and each step's run asks its questions on the same Home ([System plans](../many/plans.md)).

![Terminals for a system task: the chat, the shop-api session, its finished step, and the shop-web step working](../public/screens/real/real-09-system-task-tiles.webp)
*A system task: one session per repository, each a tile beside the chat.*

## Next

- [Folder of repositories](../many/index.md): the folder file, the commands in a folder, ports and services on one machine.
- [Systems of applications](../many/systems.md): the map, impact and contract checks.
- [System plans](../many/plans.md): plan, approve and run a change across applications.
