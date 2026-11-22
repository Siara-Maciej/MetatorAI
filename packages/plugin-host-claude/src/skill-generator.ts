import { AgentSkillsGenerator } from "@metator/core";

/** `.claude/skills/<name>/SKILL.md` (Agent Skills format) with the skill's supporting files (ADR-0039). */
export class ClaudeSkillGenerator extends AgentSkillsGenerator {
  constructor() {
    super("claude", ".claude/skills");
  }
}
