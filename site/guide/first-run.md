# Start with one repository

This page sets MetatorAI up in one repository and takes you through your first chat: a question, a quick change and a full run. It needs MetatorAI ([Install](./install.md)), git, and Claude Code (`claude`) or GitHub Copilot CLI (`copilot`) installed and logged in. Choose how you work; the steps that differ follow it.

<WaySwitch />

## Set up the repository

<Way app>

In the app, **Add repository** (on the first screen, then in the repository switcher of the top bar):

1. **Choose folder…**, or type the path of a git repository with at least one commit.
2. The app looks at the folder and lists the files setup will write. Choose the AI host, then **Set up**: the output of `metator setup` shows on the screen.
3. **Setup wrote N files. Commit them?** **Commit** commits exactly those files; **Not now** leaves them for you.
4. The app starts the repository's daemon and opens it.

[Add a repository](./desktop-app.md#add-a-repository) has every case: a folder that is not a git repository yet, a repository already set up, a folder of repositories, a dev container.

</Way>

<Way cli>

In the root of a git repository with at least one commit:

```bash
cd ~/code/shop
metator setup
```

Setup picks the AI tools itself: the ones this repository already has files for (a `.claude/` folder or `CLAUDE.md`; Copilot's files under `.github/`), or else the ones whose command is on your machine. In a terminal it asks whether to install the hooks, and about the AI tools only when nothing says which. To skip the questions:

```bash
metator setup --host claude --yes
```

```json
{"ok":true,"data":{"config":"metator.config.yml","hosts":["claude"],"hostsFrom":"option",
 "workflows":["mt-bugfix","mt-feature","mt-pr-review","mt-quick","mt-refactor","mt-review-response","mt-self-review","mt-system-change"],
 "hooks":true,
 "canon":{"mode":"install","version":"0.0.0","lock":"metator/install.lock.json","steps":{"create":49}},
 "generated":40,"gitignore":"added",
 "checks":[{"command":"meta agents-lint","passed":true},{"command":"meta skills-lint","passed":true},
           {"command":"workflow lint","passed":true},{"command":"generate --check","passed":true}],
 "next":["metator doctor","metator doctor --gates","metator serve"]}}
```

Then commit what setup wrote, yourself or with `metator setup --commit --files <the files it listed>`, which commits only those. `--host` takes `claude`, `copilot` or both. `hostsFrom` says where the choice came from: `option`, `config`, `found`, `asked`, or `default` (both).

</Way>

Setup does four things, whichever way you started it:

1. It reads your `package.json` scripts (and a Maven or Gradle build: [Java repositories](./java.md)) and writes `metator.config.yml` with the quality gates it found. An existing config is never overwritten.
2. It copies the shipped agents, skills and the eight workflows into `metator/` and `.github/metator/workflows/` (`--workflows` installs fewer).
3. It generates the files your AI tool reads (`.claude/` for Claude Code, `.github/agents/` and `.github/skills/` for Copilot) and the hooks. `--no-hooks` leaves the hooks out; without them nothing guards commits and pushes, and your word in the chat is no consent.
4. It lints what it installed.

## Check what a run can do here

```bash
metator doctor
```

Each check is `ok`, `warn` (a run starts but does less) or `fail` (a run cannot start), and each problem names the fix. It fails when the directory is not a git repository, when the repository has no commit, when there is no workflow, and when none of the AI hosts can start. It warns about uncommitted changes, a detached HEAD, missing gates, dependencies that are not installed, and a missing remote.

`metator doctor --gates` also runs the quick gate once. A red gate is worth fixing first: every quick and full run checks its change with it.

## Start the daemon

The daemon, `metator serve`, is a local process in your repository: it holds the agents' terminals, the runs and their questions.

<Way app>

The app starts it when it opens the repository. The top bar reads **connected**, and Home offers **Describe a task**.

![Home before any work: Describe a task with Start and Use the form, and + New chat at the bottom of the sidebar](../public/screens/real/real-01-home-empty.webp)
*Home before the first chat.*

</Way>

<Way cli>

Start it in a terminal of its own and leave it running:

```bash
cd ~/code/shop
metator serve
```

It listens on `http://127.0.0.1:4310`. A run's agents work in terminals the daemon owns; without it, starting a run says so.

</Way>

## Open a chat

<Way app>

Click **+ New chat** at the bottom of the sidebar (or press `n`). The chat opens: a terminal in which the conversation agent, `mt-chat`, runs on your AI tool. The daemon takes the first installed host of `supervisor.hostOrder` (`copilot`, `claude`, `opencode` by default). When none is installed, no chat opens and the app says which programs it looked for.

![A new chat: Claude Code starts in the chat's terminal, with New chat in the sidebar](../public/screens/real/real-02-new-chat.webp)
*A new chat: Claude Code runs the conversation agent in the chat's terminal.*

</Way>

<Way cli>

In another terminal, start your AI tool in the repository with the conversation agent, `mt-chat`:

```bash
cd ~/code/shop
claude --agent mt-chat        # or: copilot --agent mt-chat
```

`metator thread new --title "Discounts"` opens the same chat as a terminal of the daemon instead, which keeps it when you close your terminal; `metator attach <pane>` puts your terminal on it, and Ctrl-] detaches.

</Way>

Write in the terminal as you would talk to a colleague. For each thing you ask, the agent suggests one of three ways, and you decide.

### A question: direct

```text
› how does the discount reach the invoice?
```

The answer cites `file:line` and starts nothing. If you ask for a change that is not meant for a commit, such as a `console.log` to trace a call, the agent makes it at once and records it as a debug change: **Debug changes (N)** on Home lists it, with **Remove debug changes**, and no commit can take it by accident ([Quick and debug changes](../use/quick.md#debug-changes)).

![The chat answers how GET /prices/{sku} computes the price, citing src/server.ts and src/catalog.ts line by line, and says nothing changed](../public/screens/real/real-02-chat-answer.webp)
*A question answered in the chat with file:line; nothing changes and nothing starts.*

![The chat adds a console.log to src/server.ts at once, shows the one-line diff, and says it is recorded as a temporary edit](../public/screens/real/real-03-debug-edit.webp)
*A debug line made at once and recorded, so it can be taken out again.*

### A small change: quick

```text
› round prices half-up in src/price.ts
  This is too small for the full workflow: do it as quick?
› yes
```

Before it asks, the agent runs `metator quick check`: a command, not the model, decides whether the change is small enough (at most 5 files and 150 changed lines by default, no new dependency, no public API, and more). On yes it starts `metator quick start`. A worker makes the change in its own terminal, the quick gate runs on the changed files, and one reviewer reads the diff once. Then Home shows **Quick change ready: look at the diff**: **Open diff** shows it, **Fine** ends the run. Nothing is committed; commit it yourself, or ask the agent to ([commit and push](../use/approvals.md#commit-and-push)).

![The chat answers a small change with: This is too small for the full workflow: do it as quick?, naming the two files it would touch](../public/screens/real/real-04-quick-proposal.webp)
*The chat checks the change and suggests quick; you decide.*

<Way app>

![Home: Quick change ready: look at the diff, with Open diff, Fine and Other](../public/screens/real/real-04-quick-ready-card.webp)
*The quick run's last card: look at the diff, then Fine.*

</Way>

<Way cli>

In a terminal, `metator inbox` lists that last question with its choices. Read the diff with `git diff`, then answer with `metator run answer <question> --choice <choice>`.

</Way>

### A larger change: full

```text
› add a combined percentage and fixed discount to the invoice
```

The agent names the workflow that fits, here `mt-feature`, says why, and asks only what the repository cannot tell it, with the recommended answer first: the autonomy, and whether the run gets its own worktree. Answer, and it starts the run. The run's conductor opens in its own terminal and the chat stays where you talk.

![Terminals by task: the chat where the task was given on the left, the run's conductor working in its own Claude Code terminal on the right](../public/screens/real/real-06-task-view.webp)
*A task's terminals: the chat stays the main terminal, the run's conductor works beside it.*

The run surveys the code and writes a plan. Then it stops, and **Needs you** at the top of the sidebar goes to 1. Home shows the plan in full, with **Approve** and **Ask for changes**:

<Way app>

![Home: Approve the plan for Add GET /prices, with Approve, a field for changes and Ask for changes above the plan's five steps](../public/screens/real/real-06-plan-card.webp)
*A plan-approval card: the whole plan, Approve and Ask for changes.*

</Way>

<Way cli>

In a terminal, `metator inbox` lists the plan approval; `metator run answer <question> --choice approve` approves it. `metator session list` shows the run's terminals, and `metator attach <pane>` puts yours on one of them (Ctrl-] detaches).

</Way>

**Approve**, and the run builds: tests first, then the code, then your own `lint`, `typecheck` and `test` scripts, then the review agents. **Terminals** shows its sessions while they work. The run stops again at `delivery`; read its **Changes** first, and leave notes on lines for the agent if you want ([Read the change](../use/changes.md)). Nothing is pushed until you approve the delivery, at any autonomy level.

![A run's session: the conductor, the planner that finished with its summary, and the implementer working, each in its own terminal](../public/screens/real/real-06-session-build.webp)
*A run's session: the conductor and its workers, each in its own terminal.*

### How to decide

| Ask yourself | Take |
|---|---|
| Do I only want to know something, or see something for a moment? | direct |
| Is it a few lines I would review in a minute, and will I keep it? | quick |
| Does it need a plan, new tests, or someone's approval before it ships? | full |

The agent suggests; you can always say "do it as quick" or "use the full workflow". When a quick change grows past the limits while it works, Home asks you: **Keep as quick** or **Continue as full**.

## When a full run is done

After you approve the delivery, the run commits its change and pushes its branch, `metator/<run id>`, to `origin`. It opens a pull request only when the task asked for one. In the sidebar a finished task is hidden behind **Show finished (N)** at the end of its chat.

The run's worktree (`.metator/wt/<run id>`) keeps its ports until you remove it:

```bash
metator run close --run <id> --remove-worktree
metator worktree prune --older-than 7      # every finished run older than seven days
```

## The same from a terminal

Every step above is also a command:

```bash
metator quick start --task "Round prices half-up" --files src/price.ts   # a quick change
metator run                                  # a full run: asks for the workflow, the task and the host
metator inbox                                # what waits for you
metator run answer q001 --choice approve     # answer; your name comes from git, or give --by
metator review changes --run <id>            # what the run changed
```

An approval is never given on an agent's word. This is what a run answers when an agent reports the plan approval as passed:

```json
{"ok":false,"error":{"code":"TRANSITION_DENIED",
 "message":"Stage \"plan-approval\" (active) does not accept PASS",
 "hint":"This approval needs a person's decision: APPROVE, FAIL, ABORT."}}
```

## Update the shipped files

After you [update MetatorAI](./install.md#update), take the newer agents, skills and workflows into the repository:

```bash
metator agents update --dry-run      # what would change
metator agents update                # apply; files you changed are kept
```

A file that both you and the new version changed is reported as a conflict and your version stays. `--theirs` takes the shipped version instead.

## Next

- [Chats and the three ways](../use/start.md): what a chat keeps, and the ways in more detail.
- [Home and the Board](../use/inbox.md): answering the questions of your runs.
- [Start with many repositories](./many.md): when your work spans several repositories.
