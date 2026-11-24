/** MT-SKILL-002: a skill's description says what it does, then when to use it and when not. */
import { describe, expect, test } from "bun:test";
import { canonSkills, SOUND_SKILL, skillProblems } from "./skills.ts";

describe("MT-SKILL-002", () => {
  test("every skill of metator/skills has a sound description", async () => {
    expect(await skillProblems("MT-SKILL-002", await canonSkills())).toEqual([]);
  });

  test("rejects a description that opens with the trigger, has a tag and no anti-trigger", async () => {
    const skills = {
      "metator/skills/mt-sound/SKILL.md": SOUND_SKILL.replace(
        /^description: .*$/m,
        "description: Use when a <question> is sound.",
      ),
    };
    expect(await skillProblems("MT-SKILL-002", skills)).toEqual([
      'metator/skills/mt-sound/SKILL.md: [MT-SKILL-002] description must open with what the skill does, in the third person ("Finds …"), not "Use when"',
      'metator/skills/mt-sound/SKILL.md: [MT-SKILL-002] description must not contain "<" or ">" (no XML tags)',
      'metator/skills/mt-sound/SKILL.md: [MT-SKILL-002] description must say when not to use it ("Do not use …")',
    ]);
  });
});
