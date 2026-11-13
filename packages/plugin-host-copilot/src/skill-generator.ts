import { AgentSkillsGenerator } from "@metator/core";

/** `.github/skills/<name>/SKILL.md` (Agent Skills format) with the skill's supporting files (ADR-0039). */
export class CopilotSkillGenerator extends AgentSkillsGenerator {
  constructor() {
    super("copilot", ".github/skills");
  }
}
