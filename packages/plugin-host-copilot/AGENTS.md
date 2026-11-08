# @metator/plugin-host-copilot

`HostGenerator` and `SkillGenerator` for GitHub Copilot (`.github/`); `CopilotAgentHost` (prompt mode) and `CopilotInteractiveHost` (`copilot -i <task>` in a PTY through the `Terminal` port, D6).

- Hooks go to `.github/hooks/metator.json`; agents to `.github/agents/<id>.agent.md`.
- Pitfall: Copilot front matter keys differ from Claude Code's: map capabilities, do not copy them.
- `CopilotInteractiveHost` reports `continue` as the session id (Copilot names its sessions itself); a resume is `--continue`, or `--resume <id>` for a real UUID.
