import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { defineLoader } from "vitepress";
import { parse } from "yaml";

/** The shipped canonical agents and skills (metator/agents, metator/skills), read at build time. */
export interface AgentView {
  id: string;
  role: "coordinator" | "worker";
  description: string;
  tier: string;
  capabilities: string[];
  delegates: string[];
  artifact?: string;
}

export interface SkillView {
  name: string;
  description: string;
}

declare const data: { agents: AgentView[]; skills: SkillView[] };

export { data };

/** The front matter fields the site reads; the canon validates the rest. */
interface RawFrontMatter {
  kind?: string;
  id: string;
  name?: string;
  role: AgentView["role"];
  description: string;
  tier: string;
  capabilities?: unknown[];
  delegates?: unknown[];
  output?: { artifact?: string };
}

function frontMatter(file: string): RawFrontMatter {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file} has no front matter`);
  return parse(m[1] as string) as RawFrontMatter;
}

export default defineLoader({
  watch: ["../../../metator/agents/*.md", "../../../metator/skills/*/SKILL.md"],
  load(files: string[]) {
    const agents: AgentView[] = [];
    const skills: SkillView[] = [];
    for (const file of files.sort()) {
      const fm = frontMatter(file);
      if (fm.kind === "Agent")
        agents.push({
          id: fm.id,
          role: fm.role,
          description: fm.description,
          tier: fm.tier,
          capabilities: (fm.capabilities ?? []).map(String),
          delegates: (fm.delegates ?? []).map(String),
          ...(fm.output?.artifact ? { artifact: fm.output.artifact } : {}),
        });
      else if (fm.kind === "Skill")
        skills.push({ name: fm.name ?? basename(dirname(file)), description: fm.description });
    }
    return { agents, skills };
  },
});
