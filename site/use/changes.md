# Read the change

You can read what a run changed, leave notes on lines, and send the notes to the agent in one message. You can also open the run's worktree in your editor at a line. Nothing on this page edits the code: the agent does that, with your notes as input.

## See what a run changed

```bash
metator review changes --run <id>                         # the changed files, with added and removed line counts
metator review changes --run <id> --file src/invoice.ts   # that file's diff, as hunks with numbered lines
```

A run in its own worktree is compared with the repository's `HEAD` as it stands when you look. A run in your checkout is compared with `HEAD`. New, untracked files show whole, as added. MetatorAI's own files (`.metator/`, `.github/metator/`) are left out.

## Leave notes

```bash
metator review notes add "half-down for negatives?" --run <id> --file src/invoice.ts --line 2 --side new --by maciej
metator review notes add "tests for 1000.00" --run <id> --by maciej     # a note on the whole change
metator review notes list --run <id>
```

A note belongs to a file and a line, on the old or the new side of the diff, or to the change as a whole. It waits as a draft until you send it.

## Send the notes to the agent

```bash
metator review notes send --run <id> --by maciej
```

Every draft goes to the run as one message. The run's agents read it the next time they check the run's messages.

| Status | Meaning |
|---|---|
| `draft` | written, not sent |
| `sent` | delivered to the run |
| `addressed` | the agent replied to the message, or you marked the note |

To change a note's status by hand:

```bash
metator review notes status n002 --set addressed --run <id>
metator review notes status n002 --set draft --run <id>      # reopen it
```

## Open your editor

```bash
metator open --run <id> --file src/invoice.ts --line 2
metator open --pane w1:p2
```

`metator open` opens the run's worktree, or a pane's directory, in the editor named by the option `editor.command` (default `code`). VS Code and its forks reuse their window and jump to the line. Terminal editors open the file at the line. Other editors get the file.

## In the desktop app

The **Changes** screen lists the files on the left with their counts and a mark where you left notes. The chosen file's diff is on the right.

- Click a line to write a note there.
- Double-click a line to open it in your editor.
- **+ note on the whole change** is below the file list.
- **Send N to agent** sends the drafts.
- **Open in editor** opens the worktree.

Open the screen from the workbench with the prefix and `r`, or from a pane's menu.

For the agents' own review of a change, see [Review a change](./review.md).
