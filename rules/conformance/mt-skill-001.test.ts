/** MT-SKILL-001: a skill's name is kebab-case, its directory, prefixed, with no reserved word. */
import { describe, expect, test } from "bun:test";
import { canonSkills, SOUND_SKILL, skillProblems } from "./skills.ts";

describe("MT-SKILL-001", () => {
  test("every skill of metator/skills has a sound name", async () => {
    expect(await skillProblems("MT-SKILL-001", await canonSkills())).toEqual([]);
  });

  test("rejects a name with a reserved word, another directory and no prefix", async () => {
    const skills = {
      "metator/skills/sound/SKILL.md": SOUND_SKILL.replace("name: mt-sound", "name: claude-sound"),
    };
    expect(await skillProblems("MT-SKILL-001", skills)).toEqual([
      "metator/skills/sound/SKILL.md: [MT-SKILL-001] name must match its directory (sound)",
      'metator/skills/sound/SKILL.md: [MT-SKILL-001] name must start with "mt-"',
      'metator/skills/sound/SKILL.md: [MT-SKILL-001] name must not contain the reserved word "claude"',
    ]);
  });
});
