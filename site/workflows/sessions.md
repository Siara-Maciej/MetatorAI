# Sessions in the terminal

**What for:** with several runs going at once, each in its own worktree, you need one place to see which run waits for you, answer it, start its application, look at its code and its diff. `metator ui` is that place. Every run is a session; nothing in it needs a second window.

```bash
metator ui
```

```text
◆  Sessions · 1 question(s) for you
│  ● 20261027-mt-feature-add-combined-discount · plan-approval   (waits for you (1))
│  ○ 20261027-mt-bugfix-fix-rounding · build                      (driving)
│  ○ New run
│  ○ Questions (1)
│  ○ Quit
```

The terminal bell rings when a new question arrives.

## What a session offers

Pick a session to see its stage, its state and its worktree, then:

| Action | What it does |
|---|---|
| Watch live | the live view of [`metator run`](./drive.md): every step, every question asked on the spot; Ctrl+C comes back here |
| Continue the run | a stopped run is driven again with the host it used, and watched |
| Answer questions (n) | the run's open questions, one by one |
| Applications | the services of [the environment](../how-to/environments.md) in this worktree: start all, stop all, and per service start, stop, logs and open its URL in the browser |
| Open in editor | opens the worktree in your editor |
| Shell here | your `$SHELL` in the worktree; exit it to come back |
| Diff | what the run changed since its worktree branched off, as `git diff` |
| Stop the drive | the run stays where it is; continue it any time |

**Questions** on the first screen is the inbox: every open question of every run, so you can answer them all without opening each session.

## The editor

The editor comes from `editor:` in `metator.config.yml`, then `$VISUAL`, then `$EDITOR`. When none is set, `metator ui` lists the editors it finds on your `PATH` (VS Code, Cursor, Windsurf, Zed, IntelliJ IDEA, WebStorm, Sublime Text, Neovim, Vim, Helix, nano, Emacs), and saves the one you pick:

```yaml
editor: code --new-window
```

The file keeps its comments. Window editors open on their own and the menu comes back at once; terminal editors (Neovim, Vim, Helix, nano, Emacs) take over the terminal until you quit them.

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
