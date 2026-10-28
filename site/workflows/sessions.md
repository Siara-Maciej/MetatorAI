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

## Without a terminal

`metator ui` needs one; in a script it fails with `USAGE`. Use the commands it is made of: `run continue`, `run questions`, `run answer`, `env up|down|status|logs`, `worktree list`.
