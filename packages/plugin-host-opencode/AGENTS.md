# @metator/plugin-host-opencode

`InteractiveHost` on OpenCode (D6, ADR-0077): `opencode <worktree> --prompt <task>` in a PTY through the `Terminal` port; `--session <id>` or `--continue` resumes.

- OpenCode names its sessions itself: a started session reports `continue`, and a resume takes the most recent session of the worktree unless a real `ses_…` id is given.
- The agent flag is passed only when `.opencode/agent/<id>.md` exists in the repository.
- Pitfall: the contract test runs on a stand-in script (`standInCli`), not the real CLI; the argv it prints is what the test reads.
