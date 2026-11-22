# @metator/plugin-codehost-gh

The `ReviewHost` and `ReviewerHost` ports over GitHub's `gh` CLI (ADR-0097): GitHub only, with gh's own login; no token in MetatorAI.

- `gh-review-host.ts`: `GhReviewHost`, run through the `ProcessRunner` port (the `gh` binary, `METATOR_GH_BIN` or `gh` on PATH). Pure parts are exported and tested alone: `ghCalls(source)` (the argument lists per operation), `requestsFromGh`, `threadsFromGh`, `requestFromGh` (gh's JSON to the port's types).
- A review is posted in one call (`gh api …/pulls/<n>/reviews` with `comments[][…]` fields); the posted comments' ids are read back from the threads.
- `status({ standIn })`: whether gh runs and is logged in. While real hosts are refused (`METATOR_NO_REAL_HOSTS`), only a stand-in that says so in its `--version` line counts, and a real gh is never asked anything that could reach GitHub.
- Pitfall: gh's failures are error values (`COMMAND_FAILED` with the first line of stderr, `BIN_NOT_FOUND` for exit 127), never a throw. A GitLab source is refused: GitLab is read through MCP.
- Tests run `reviewHostContract` and `reviewerHostContract` over the stand-in `gh` (`e2e/helpers/fake-gh.ts`, `writeGhShim`); never the real one.
