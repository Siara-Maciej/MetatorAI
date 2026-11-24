/** MT-SKILL-005: a skill names only skills that exist. */
import { describe, expect, test } from "bun:test";
import { canonSkills, SOUND_SKILL, skillProblems } from "./skills.ts";

describe("MT-SKILL-005", () => {
  test("every skill that metator/skills names is one of them", async () => {
    expect(await skillProblems("MT-SKILL-005", await canonSkills())).toEqual([]);
  });

  test("rejects a skill that names one the canon does not have", async () => {
    const skills = {
      "metator/skills/mt-sound/SKILL.md": SOUND_SKILL.replace(
        "1. Answer it.",
        "1. Use skill mt-sound to start, then skill `mt-no-such-skill`.",
      ),
    };
    expect(await skillProblems("MT-SKILL-005", skills)).toEqual([
      "metator/skills/mt-sound/SKILL.md: [MT-SKILL-005] names skill mt-no-such-skill, which is not a skill of this repository's canon",
    ]);
  });
});
