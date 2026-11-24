/** MT-SKILL-004: a skill's supporting files are listed, named, one level deep and navigable. */
import { describe, expect, test } from "bun:test";
import { canonSkills, SOUND_SKILL, skillProblems } from "./skills.ts";

describe("MT-SKILL-004", () => {
  test("every skill of metator/skills ships, names and keeps its files one level deep", async () => {
    expect(await skillProblems("MT-SKILL-004", await canonSkills())).toEqual([]);
  });

  test("rejects a file nobody names, a nested reference and a long file without contents", async () => {
    const skills = {
      "metator/skills/mt-sound/SKILL.md": SOUND_SKILL.replace(
        "---\n# When",
        "files: [references/a.md, references/b.md]\n---\n# When",
      ).replace("1. Answer it.", "1. Answer it with references/a.md."),
      "metator/skills/mt-sound/references/a.md": `# A\nThen read references/b.md.\n${"x\n".repeat(100)}`,
      "metator/skills/mt-sound/references/b.md": "# B\n",
    };
    expect(await skillProblems("MT-SKILL-004", skills)).toEqual([
      "metator/skills/mt-sound/SKILL.md: [MT-SKILL-004] references/a.md names references/b.md; a reference names no other supporting file (one level deep from SKILL.md)",
      'metator/skills/mt-sound/SKILL.md: [MT-SKILL-004] references/a.md has 102 lines; start it with a "## Contents" heading within its first 10 lines',
      "metator/skills/mt-sound/SKILL.md: [MT-SKILL-004] lists references/b.md, but the body never names it; name it where a step uses it, or drop it",
    ]);
  });
});
