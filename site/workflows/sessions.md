# Sessions in the terminal

**What for:** with several runs going at once, each in its own worktree, you need one place to see what each run is doing, which one waits for you and for what, to answer it, start its application, look at its code and ask about the code. `metator ui` is that place: one full-screen view, like an AI coding CLI, built for runs.

```bash
metator ui
```

```text
 MetatorAI · shop                                        1 need you · 1 driving · 0 stopped · 1 services
╭ SESSIONS ─────────────────────────────╮╭──────────────────────────────────────────────────────────────╮
│ ? Add combined discount · plan-approval││ Add combined discount                                         │
│ ⟳ Fix rounding of VAT · build          ││ 20261028-mt-feature-add-combined-discount · mt-feature · L0 ·  │
│ ✓ Docs links · done                    ││   claude · 7 min                                              │
│ Conversations                          ││ ? needs you · waits for you: approve the plan  (a: answer)    │
│ ✦ How is VAT computed?                 ││ intake ✓ ─ context ✓ ─ plan ✓ ─ [plan-approval ?] ─ build ·   │
│                                        ││  Overview  Activity  Apps                                     │
│                                        ││ Questions for you (1)                                         │
│                                        ││ q001 plan-approval · gate: The human approves the plan        │
│                                        ││ worktree: metator/20261028-… · ports 41000–41019              │
╰────────────────────────────────────────╯╰──────────────────────────────────────────────────────────────╯
 ↑↓ select · ⏎ act · tab view · a answer · n new run · ? ask · c continue · : all commands · , settings · q quit
```

**On the screen:**
- **The header:** how many sessions need you, how many are driving or stopped, how many services run.
- **Sessions on the left:** runs, the ones that need you first, then the conversations of [`metator ask`](./ask.md). In a [folder of repositories](../multi-repo/repositories.md#a-folder-of-repositories), every repository's runs, under its name.
- **The selected session on the right:**
  - what it needs now, and the key that does it;
  - its stages, with the current one in brackets: `✓` done, `⟳` working, `?` waits for you, `!` stopped, `·` still to come;
  - three tabs (`tab`, `←` `→`): **Overview** (the questions, the last thing that happened, the worktree and its ports), **Activity** (live) and **Apps** (the worktree's services).

The view refreshes by itself; the terminal bell rings when a new question arrives. `q` gives your terminal back as it was.

## Keys

| Key | Does |
|---|---|
| `↑` `↓` (`k` `j`) | select a session |
| `⏎` | what the session needs: answer it, continue it, or follow up in a conversation |
| `a` | answer the run's question; at a human gate nobody drives, approve it or reject it with a reason |
| `c` · `x` | continue the run (drive it again with the host it used) · stop its drive |
| `n` | new run: repository, workflow, task, autonomy, AI host, own worktree or not |
| `?` · `r` | ask about the code · follow up in the selected conversation |
| `u` · `w` | start · stop the run's applications |
| `e` · `t` · `d` | open the worktree in your editor · a shell there · the run's diff |
| `g` | go to the next session that needs you |
| `,` | settings |
| `:` or `Ctrl+K` | every action by name, with a filter |
| `q` | quit |

An answer is carried out by the run's drive: when none is running, `metator ui` starts it again with the host that drove the run, so you never have to continue by hand after answering.

A terminal editor, the shell and the diff get the whole terminal; when you leave them, the view comes back where you were. A window editor (VS Code, Cursor, Zed…) opens on its own.

## Settings

`,` opens the settings, saved in `metator.config.yml` (comments and other settings are kept):

| Setting | What it changes |
|---|---|
| Editor | the editor `e` opens: picked from the editors found on your `PATH` (VS Code, Cursor, Windsurf, Zed, IntelliJ IDEA, WebStorm, Sublime Text, Neovim, Vim, Helix, nano, Emacs), or any command such as `code --new-window` |
| AI hosts | which hosts get the agents, skills and hooks (`hosts.targets`); run `metator agents update` afterwards |

Without an `editor:` setting, `$VISUAL` and then `$EDITOR` are used. New runs and questions use the first AI host of the list, or `$METATOR_HOST` when it names one (`claude`, `copilot`, `scenario`).

## The work at a glance

```bash
metator status
```

```json
{"runs":[
  {"runId":"20261028-mt-feature-add-discount","task":"Add discount","attention":"you","stage":"plan-approval",
   "stages":[{"id":"intake","state":"done"},{"id":"plan","state":"done"},{"id":"plan-approval","state":"waiting","hitl":true},{"id":"build","state":"next"}],
   "questions":[{"id":"q001","source":"gate","prompt":"The human approves the plan: approve to continue"}],
   "host":"claude","driving":false,"elapsedMs":420000,
   "worktree":{"id":"20261028-mt-feature-add-discount","branch":"metator/20261028-mt-feature-add-discount","ports":{"from":41000,"count":20}},
   "services":[{"service":"api","status":"running","ports":{"http":41000}}]}],
 "conversations":[{"id":"20261028-how-is-vat-computed","title":"How is VAT computed?","turns":2}],
 "counts":{"you":1,"driving":0,"stopped":0,"finished":3,"questions":1,"services":1}}
```

| `attention` | Meaning |
|---|---|
| `you` | a question waits for you, or a human gate nobody drives: answer, approve, or continue the run |
| `driving` | the drive is working; watch it live |
| `stopped` | nobody drives it; continue it any time |
| `done`, `escalated`, `aborted` | finished, and how |

Runs come sorted the same way: what waits for you first. In a [folder of repositories](../multi-repo/repositories.md#a-folder-of-repositories), `metator status` gives this for every repository, with the sums.

## Without a terminal

`metator ui` needs one; in a script it fails with `USAGE`. Use `metator status` for the overview, and the commands `ui` is made of: `run continue`, `run questions`, `run answer`, `env up|down|status|logs`, `worktree list`.
