# @metator/plugin-host-copilot

`HostGenerator` and `SkillGenerator` for GitHub Copilot (`.github/`).

- Hooks go to `.github/hooks/metator.json`; agents to `.github/agents/<id>.agent.md`.
- Pitfall: Copilot front matter keys differ from Claude Code's: map capabilities, do not copy them.
