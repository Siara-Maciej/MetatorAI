# @metator/plugin-host-claude

`HostGenerator` and `SkillGenerator` for Claude Code (`.claude/`); `ClaudeAgentHost` (Agent SDK) and `ClaudeInteractiveHost` (`claude <task> --session-id <uuid>` in a PTY through the `Terminal` port, D6).

- Hook configuration merges into `.claude/settings.json`; never overwrite settings the user wrote.
- Pitfall: Tool names in generated front matter must match Claude Code's names exactly.
- `ClaudeInteractiveHost` chooses the session UUID itself and resumes with `--resume <uuid>`; the agent flag goes only when `.claude/agents/<id>.md` exists. The contract test of every interactive host runs on a stand-in script (`standInCli` in `@metator/testing`), as the Copilot and OpenCode ones do.
