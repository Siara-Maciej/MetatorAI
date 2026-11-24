/** MT-SKILL-003: a skill's body has the template's sections, in order, within 300 lines. */
import { describe, expect, test } from "bun:test";
import { canonSkills, SOUND_SKILL, skillProblems } from "./skills.ts";

describe("MT-SKILL-003", () => {
  test("every skill of metator/skills has its sections in order, Steps first after When", async () => {
    expect(await skillProblems("MT-SKILL-003", await canonSkills())).toEqual([]);
  });

  test("rejects a body whose steps are pushed down and that runs past the budget", async () => {
    const skills = {
      "metator/skills/mt-sound/SKILL.md": `${SOUND_SKILL.replace("# Steps", "# Background\nWhy.\n\n# Steps")}${"more\n".repeat(285)}`,
    };
    expect(await skillProblems("MT-SKILL-003", skills)).toEqual([
      'metator/skills/mt-sound/SKILL.md: [MT-SKILL-003] "# Steps" must come right after "# When", found "# Background" between',
      "metator/skills/mt-sound/SKILL.md: [MT-SKILL-003] body has 302 lines, the budget is 300",
    ]);
  });
});
