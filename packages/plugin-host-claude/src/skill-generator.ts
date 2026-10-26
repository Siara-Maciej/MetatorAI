import {
  agentSkillLayout,
  type GeneratedFile,
  generatedMarker,
  type Skill,
  type SkillGenerator,
} from "@metator/core";

/** `.claude/skills/<name>/SKILL.md` (Agent Skills format) with the skill's supporting files (ADR-0039). */
export class ClaudeSkillGenerator implements SkillGenerator {
  readonly host = "claude";
  readonly root = ".claude/skills";
  readonly owns = `${this.root}/*/SKILL.md`;

  skill(skill: Skill, body: string, files: readonly GeneratedFile[], context: { readonly source: string }) {
    return agentSkillLayout(this.root, skill, body, files, generatedMarker(context.source));
  }
}
