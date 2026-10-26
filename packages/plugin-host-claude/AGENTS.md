# @metator/plugin-host-claude

`HostGenerator` and `SkillGenerator` for Claude Code (`.claude/`).

- Hook configuration merges into `.claude/settings.json`; never overwrite settings the user wrote.
- Pitfall: Tool names in generated front matter must match Claude Code's names exactly.
