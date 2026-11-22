import { describe, expect, test } from "bun:test";
import {
  AgentDocument,
  HOOK_BINDINGS,
  type HostGenerator,
  isGeneratedHostFile,
  matchesAny,
  type SkillGenerator,
} from "@metator/core";

const SOURCE = "metator/agents/mt-contract.md";
const BODY = "\n# Input\nRun `metator graph deps a.ts`.\n";

const agent = () =>
  AgentDocument.parse(
    {
      kind: "Agent",
      schemaVersion: 1,
      id: "mt-contract",
      role: "worker",
      description: "Does one job, used by the coordinator only.",
      tier: "standard",
      capabilities: ["read", "search", "metator:graph"],
    },
    "mt-contract.md",
  )._unsafeUnwrap();

/**
 * Every HostGenerator adapter (ADR-0030, ADR-0038) passes this suite: an agent file lands where
 * the generator says it owns files, carries the generated marker and the repository's own
 * MetatorAI command; the hook configuration runs every guard and generating it again changes
 * nothing.
 */
export function hostGeneratorContract(name: string, make: () => HostGenerator): void {
  describe(`HostGenerator contract: ${name}`, () => {
    test("an agent file is one the generator owns, marked as generated, with front matter first", () => {
      const g = make();
      const file = g.agent(agent(), BODY, { source: SOURCE, metatorCommand: "metator" });
      expect(matchesAny(file.path, g.owns)).toBe(true);
      expect(file.path).toContain("mt-contract");
      expect(file.content.startsWith("---\n")).toBe(true);
      expect(isGeneratedHostFile(file.content)).toBe(true);
      expect(file.content).toContain(SOURCE);
      expect(file.content).toContain("# Input");
    });

    test("the agent's prose runs MetatorAI the way the repository does", () => {
      const file = make().agent(agent(), BODY, { source: SOURCE, metatorCommand: "bun run metator" });
      expect(file.content).toContain("`bun run metator graph deps a.ts`");
      expect(file.content).not.toContain("`metator graph deps a.ts`");
    });

    test("the hook configuration is the generator's hooks file and runs every guard", () => {
      const g = make();
      const file = g.hooks("bun run metator", undefined)._unsafeUnwrap();
      expect(file.path).toBe(g.hooksFile);
      expect(() => JSON.parse(file.content)).not.toThrow();
      for (const b of HOOK_BINDINGS) expect(file.content).toContain(`bun run metator guard ${b.guard}`);
    });

    test("generating the hooks again changes nothing; a new command replaces the old one", () => {
      const g = make();
      const first = g.hooks("metator", undefined)._unsafeUnwrap();
      expect(g.hooks("metator", first.content)._unsafeUnwrap()).toEqual(first);
      const moved = g.hooks("bunx metator", first.content)._unsafeUnwrap();
      expect(moved).toEqual(g.hooks("bunx metator", undefined)._unsafeUnwrap());
      expect(moved.content).not.toContain('"metator guard');
    });
  });
}

/**
 * Every SkillGenerator adapter (ADR-0039) passes this suite: SKILL.md is a file the generator
 * owns, marked as generated, and the skill's supporting files come along unchanged beside it.
 */
export function skillGeneratorContract(name: string, make: () => SkillGenerator): void {
  describe(`SkillGenerator contract: ${name}`, () => {
    const skill = {
      name: "mt-contract-skill",
      description: "Use when a contract runs. Do not use otherwise.",
      files: ["scripts/a.sh"],
    };
    const context = { source: "metator/skills/mt-contract-skill/SKILL.md", metatorCommand: "metator" };

    test("SKILL.md is a file the generator owns, with the skill's name and the generated marker", () => {
      const g = make();
      const [main] = g.skill(skill, "# When\nx\n", [], context);
      expect(main && matchesAny(main.path, [g.owns])).toBe(true);
      expect(main?.path).toContain("/mt-contract-skill/");
      expect(main?.content.startsWith("---\n")).toBe(true);
      expect(main?.content).toContain("name: mt-contract-skill");
      expect(isGeneratedHostFile(main?.content ?? "")).toBe(true);
      expect(main?.content).toContain(context.source);
      expect(main?.content).toContain("# When\nx\n");
    });

    test("supporting files come along unchanged, in the skill's directory", () => {
      const files = make().skill(
        skill,
        "# When\nx\n",
        [{ path: "scripts/a.sh", content: "echo hi\n" }],
        context,
      );
      expect(files).toHaveLength(2);
      const dir = (files[0]?.path ?? "").replace(/\/SKILL\.md$/, "");
      expect(files[1]).toEqual({ path: `${dir}/scripts/a.sh`, content: "echo hi\n" });
    });
  });
}
