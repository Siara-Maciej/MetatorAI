# Changelog

What changed on the default branch, newest first, in terms a user sees. MetatorAI is pre-alpha and installed from a checkout, so there are no numbered releases yet.

Every file MetatorAI writes carries a `schemaVersion`. When a document gets a new version, it is named here. Older files keep loading.

## November 2026

- Documentation rebuilt in four sections: Guide, Use, Repository, Reference. Old addresses changed.
- Automatic intake: rules under `intake` turn issues from GitHub, GitLab or Jira into tasks and runs (`metator intake rules`, `scan`, `status`).
- Reviews of your own pull requests: `metator mrs list`, `show`, `scan`, `triage`, `send`, `resolve`, and the `mt-review-response` workflow. New document: `PullRequestReview`.
- MCP servers in the configuration (`mcp`), written to `.mcp.json` by `metator generate`. `metator mcp` serves MetatorAI's reading commands as MCP tools.
- Options with three scopes (user, repository, run): `metator config list`, `get`, `set`, `unset`. New document: `UserOptions`.
- A backlog of tasks: `metator issue list`, `add`, `propose`, `decide`, `start`. New document: `Issue`.
- Notes on a change: `metator review changes` and `metator review notes`. New document: `ReviewNotes`.
- Sessions in terminals that the daemon owns (`metator serve`, `metator attach`, `metator pane`), the inbox (`metator inbox`), a supervisor (`metator supervise`) and the desktop app.
- `MetatorConfig` is at version 12: `notify` (6), `supervisor` (7), `options` (8), `mcp` (9), `intake` (10), `reviews` (11). Version 12 removes `paths.runs`, `paths.index`, `paths.discovery` and `paths.gates`: local state always lives under `.metator/`. An older file that sets one still loads, and the key is ignored; MetatorAI drops it the next time it writes the file.
- Workflow preconditions are checked when a run starts: `clean-tree`, `branch-ok`, `tests-green`. `index-fresh` is gone; run `metator setup` to update installed workflows. A run in your checkout now refuses on uncommitted changes when its workflow requires `clean-tree` (`--allow-dirty` starts it anyway).
- `metator doctor --gates` runs the quick gate once and reports whether it is green.
- `metator graph cycles --check` fails on an import cycle. A type-only import counts.
- `metator rules pack --files` replaces `--paths`, and `metator eval run --timeout` replaces `--timeout-ms`. The old names still work.
- `metator plan scope --dry-run` prints the scope without writing it. `plan scope` is an MCP tool again and never writes.
- In `mt-pr-review` at autonomy `L2`, the skipped approval gate grants `comment`, so the publish stage can post.
- `metator init` and `metator system discover` put warnings only in `warnings`, not in `data` as well.

## October 2026

- `metator setup`, and `metator agents install` and `agents update` with an install lock.
- A worktree per run with its own ports; `metator run drive`, `run continue`, questions and answers from the terminal.
- Application environments: `metator env discover`, `init`, `up`, `down`, `status`, `logs`.
- `metator ui`, `metator ask` with citations, `metator status`, and a folder of several repositories.
- Package architecture: `metator arch analyze`, `check`, `simulate`, `plan`, `eval`.
- Systems of several applications: the system map, `metator system discover`, `impact`, `analyze`, `plan`, and `metator contract diff`.
- Review with verified findings, a verdict, and scoring on recorded cases (`metator eval`).
- Rules enforced by tools (ast-grep, Biome, tsc), patterns, module cards and the memory map.
