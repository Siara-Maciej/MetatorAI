import { generatedMarker, withMetatorCommand } from "../domain/agent.ts";
import { agentSkillLayout, type Skill } from "../domain/skill.ts";
import { renderYamlFields } from "../domain/versioned.ts";
import type { GeneratedFile, HostAgentContext, SkillGenerator } from "../ports/index.ts";

/**
 * A host's agent file as every host reads it: YAML front matter, the generated marker, then the
 * agent's prose with the repository's own MetatorAI command. `note` goes between the marker and
 * the prose (what a host cannot express in its front matter).
 */
export function hostAgentFile(
  path: string,
  front: Record<string, unknown>,
  body: string,
  context: HostAgentContext,
  note = "",
): GeneratedFile {
  const text = withMetatorCommand(body, context.metatorCommand);
  const prose = text.startsWith("\n") ? text : `\n${text}`;
  return {
    path,
    content: `---\n${renderYamlFields(front)}\n---\n${generatedMarker(context.source)}\n${note}${prose}`,
  };
}

/**
 * SkillGenerator of a host that reads the Agent Skills format (ADR-0039):
 * `<root>/<name>/SKILL.md` with the skill's supporting files. Hosts differ only in `root`.
 */
export class AgentSkillsGenerator implements SkillGenerator {
  readonly owns: string;

  constructor(
    readonly host: SkillGenerator["host"],
    readonly root: string,
  ) {
    this.owns = `${root}/*/SKILL.md`;
  }

  skill(
    skill: Skill,
    body: string,
    files: readonly GeneratedFile[],
    context: { readonly source: string },
  ): readonly GeneratedFile[] {
    return agentSkillLayout(this.root, skill, body, files, generatedMarker(context.source));
  }
}
