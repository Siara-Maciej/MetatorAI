/**
 * Skills, `meta check-all` and `meta audit` end to end: the real `metator` process on a real git
 * repository with canonical agents, a canonical skill and hand-written host files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const SKILL = `---
kind: Skill
schemaVersion: 1
name: mt-find-patterns
description: Use when a plan creates a file and needs an exemplar. Do not use for text search or review.
files: [scripts/similar.sh]
---
# When
A plan creates a file.

# Steps
1. Run scripts/similar.sh with the planned path.

# Output
patternSource with an exemplar.

# Checklist
- [ ] the exemplar is not legacy

# Errors
STALE_INDEX: run \`metator index build\`.
`;
const ORCHESTRATOR = `---
kind: Agent
schemaVersion: 1
id: mt-orchestrator
role: coordinator
description: Runs the workflow and delegates every stage to workers.
tier: reasoning
capabilities: [read, agent]
delegates: [eq-planner]
---
# Role
Coordinates; uses mt-find-patterns through workers.
# Rules
Delegate.
# Stages
G1.
# Escalation
Ask.
# Final report
Short.
`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("README.md", "# acme\n");
  await repo.write(
    "metator.config.yml",
    "kind: MetatorConfig\nschemaVersion: 1\nhosts:\n  metatorCommand: npx metator\n",
  );
  await repo.write("metator/skills/mt-find-patterns/SKILL.md", SKILL);
  await repo.write(
    "metator/skills/mt-find-patterns/scripts/similar.sh",
    '#!/bin/sh\nmetator similar --file "$1"\n',
  );
  await repo.write("metator/agents/mt-orchestrator.md", ORCHESTRATOR);
  await repo.write(
    ".github/agents/eq-planner.agent.md",
    "---\nname: eq-planner\nagents: [eq-old]\n---\nPlans.\n",
  );
  await repo.write(".github/agents/eq-old.agent.md", "---\nname: eq-old\nagents: [eq-older]\n---\nOld.\n");
  await repo.write(
    ".github/agents/eq-older.agent.md",
    "---\nname: eq-older\nuser-invokable: false\n---\nOlder.\n",
  );
  await repo.write(
    ".github/agents/eq-orphan.agent.md",
    "---\nname: eq-orphan\nuser-invokable: false\n---\nNobody calls me.\n",
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("canonical skills (real CLI)", () => {
  test("skills-lint passes a healthy skill and names every problem of a broken one", async () => {
    expect((await metator(["meta", "skills-lint"], repo.root)).json.data).toEqual({
      skills: 1,
      problems: [],
    });
    await repo.write(
      "metator/skills/mt-broken/SKILL.md",
      "---\nkind: Skill\nschemaVersion: 1\nname: mt-broken\ndescription: Finds things somewhere in the repo.\n---\n# When\nx\n",
    );
    try {
      const r = await metator(["meta", "skills-lint"], repo.root);
      expect(r.code).toBe(1);
      const messages = ((r.json.error as { details: Data }).details.problems as { message: string }[]).map(
        (p) => p.message,
      );
      expect(messages).toContain('description must say when to use it ("Use when …")');
      expect(messages).toContain('missing section "# Steps" or "# Kroki"');
    } finally {
      await repo.git("clean", "-fdq", "metator/skills/mt-broken");
    }
    const schema = (await metator(["meta", "skills-schema"], repo.root)).json.data as {
      properties: Record<string, Data>;
    };
    expect(schema.properties.kind?.const).toBe("Skill");
  });

  test("generate writes both hosts' skill directories with the supporting files; --check is clean after", async () => {
    const r = await metator(["generate"], repo.root);
    expect(r.code).toBe(0);
    for (const root of [".claude/skills", ".github/skills"]) {
      const text = await repo.read(`${root}/mt-find-patterns/SKILL.md`);
      expect(
        text.startsWith("---\nname: mt-find-patterns\ndescription: Use when a plan creates a file"),
      ).toBe(true);
      expect(text).toContain("`npx metator index build`");
      expect(await repo.read(`${root}/mt-find-patterns/scripts/similar.sh`)).toContain("metator similar");
    }
    expect((await metator(["generate", "--check"], repo.root)).code).toBe(0);
    await repo.write(".github/skills/mt-find-patterns/SKILL.md", "edited by hand");
    const stale = await metator(["generate", "--check"], repo.root);
    expect([stale.code, (stale.json.error as { details: Data }).details.stale]).toEqual([
      1,
      [".github/skills/mt-find-patterns/SKILL.md"],
    ]);
    await metator(["generate"], repo.root);
  });
});

describe("metator meta audit (real CLI)", () => {
  test("inventories canon and host files and reports dead elements and deep delegation", async () => {
    const r = await metator(["meta", "audit"], repo.root);
    expect(r.code).toBe(0);
    const audit = r.json.data as {
      nodes: { id: string; origin: string }[];
      dead: string[];
      tooDeep: string[][];
    };
    expect(audit.nodes.filter((n) => n.origin === "host").map((n) => n.id)).toEqual([
      "eq-old",
      "eq-older",
      "eq-orphan",
      "eq-planner",
    ]);
    expect(audit.dead).toEqual(["eq-orphan"]);
    expect(audit.tooDeep).toEqual([["mt-orchestrator", "eq-planner", "eq-old", "eq-older"]]);
    expect(r.json.warnings).toContain("eq-orphan: nothing reaches it from an entry point");
  });
});

describe("metator meta check-all (real CLI)", () => {
  test("runs every check in one process and names each failing one with its error", async () => {
    const r = await metator(["meta", "check-all"], repo.root);
    expect([r.code, (r.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    const checks = (
      r.json.error as { details: { checks: { command: string; passed: boolean; error?: string }[] } }
    ).details.checks;
    expect(checks).toHaveLength(12);
    expect(checks.find((c) => c.command === "memory check")?.error).toBe(
      "NOT_FOUND: No memory map at docs/metator/memory-map.yml",
    );
    expect(checks.find((c) => c.command === "rules coverage --min-e1 40")?.passed).toBe(false);
    expect(checks.find((c) => c.command === "meta skills-lint")?.passed).toBe(true);
  });

  test("dogfood: MetatorAI passes its own check-all at 100% E1", async () => {
    const r = await metator(["meta", "check-all", "--min-e1", "100", "--root", SELF], SELF);
    expect([r.code, (r.json.data as { checks: unknown[] }).checks.length]).toEqual([0, 12]);
  }, 60_000);
});
