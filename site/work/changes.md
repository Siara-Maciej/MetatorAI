# The change and your notes on it

**What for:** read what a run changed without leaving the app, say what you think line by line, and hand those notes to the agent in one go. Or open the worktree in your editor at the exact line. Nothing here edits the code: the agent does, with your notes as data.

```bash
metator review changes --run <id>                     # the files the run changed, with + and − counts
metator review changes --run <id> --file src/invoice.ts   # that file's diff as hunks and numbered lines
metator review notes add "half-down for negatives?" --run <id> --file src/invoice.ts --line 2 --side new --by maciej
metator review notes add "tests for 1000.00" --run <id> --by maciej      # a note on the whole change
metator review notes send --run <id> --by maciej      # every draft note, as one message to the run (topic review)
metator review notes list --run <id>                  # draft · sent · addressed
metator review notes status n002 --set draft --run <id>   # reopen one (or --set addressed)
metator open --run <id> --file src/invoice.ts --line 2    # your editor (editor.command) at the line
```

## What a run changed

A run in its own worktree is measured against the repository's `HEAD` as it stands when you look; a run in the checkout against `HEAD`. New, untracked files show whole as added. MetatorAI's own files (`.metator/`, `.github/metator/`) are never part of the change.

## Notes

A note is yours: a file and a line (on the old or the new side of the diff), or the change as a whole. It waits as a **draft** in `.metator/runs/<id>/review/notes.json` (`ReviewNotes` v1) until you send. **Send** delivers every draft note as one `RunMessage` with topic `review` to the run: the conductor reads it at its next `run status` or `run messages`, a worker through its card. The notes remember the message (`sentIn`) and read as **sent**. When the agent answers with `metator run message <run> --from <run> --topic review-reply --ref <message id> …`, the notes it answers read as **addressed**; you can confirm or reopen any note by hand.

## Your editor

`editor.command` (an option; `code` by default) opens the run's worktree, or a pane's directory, at a file and line when given. VS Code and its forks (Cursor, Windsurf) reuse their window and get `--goto file:line`; terminal editors get `+line file`; others the file. Every opening is noted in the run's activity.

## In the app

The **Changes** screen (`#/review/<run>`; *Changes* in a pane's menu, `prefix+r` on the workbench, *Review* in a session's Changes box) lists the files on the left with their counts and a ✎ where you left notes; the chosen file's diff is on the right. A click on a line opens a note there, a double click opens the line in your editor; *+ note on the whole change* is below the file list. **Send N to agent** sends the drafts. The notes list shows each note's status with ✓ (mark addressed) and ↺ (reopen). The **editor** button in the workbench's process strip, *Open in editor* in a pane's menu and in a session open the worktree or the pane's directory.

## Next

- [Review](./review.md): the agents' review of a change, the other direction.
- [Terminals, panes and the conductor](./terminals.md): the panes whose directories open.
