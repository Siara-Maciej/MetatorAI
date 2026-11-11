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
- `MetatorConfig` is at version 11: `notify` (6), `supervisor` (7), `options` (8), `mcp` (9), `intake` (10), `reviews` (11).

## October 2026

- `metator setup`, and `metator agents install` and `agents update` with an install lock.
- A worktree per run with its own ports; `metator run drive`, `run continue`, questions and answers from the terminal.
- Application environments: `metator env discover`, `init`, `up`, `down`, `status`, `logs`.
- `metator ui`, `metator ask` with citations, `metator status`, and a folder of several repositories.
- Package architecture: `metator arch analyze`, `check`, `simulate`, `plan`, `eval`.
- Systems of several applications: the system map, `metator system discover`, `impact`, `analyze`, `plan`, and `metator contract diff`.
- Review with verified findings, a verdict, and scoring on recorded cases (`metator eval`).
- Rules enforced by tools (ast-grep, Biome, tsc), patterns, module cards and the memory map.
