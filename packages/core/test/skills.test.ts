import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { GenerateSkills, LintSkills, SkillCatalog } from "../src/application/skills.ts";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import {
  agentSkillLayout,
  frontMatterRule,
  headingsOf,
  namedSkills,
  referencedFiles,
  type Skill,
} from "../src/domain/skill.ts";
import type { GeneratedFile, SkillGenerator } from "../src/ports/index.ts";

const BODY = `# When
Before writing a new file.

# Steps
1. \`metator similar --file <path>\`
2. Run scripts/similar.sh

# Output
pattern_source

# Checklist
- [ ] exemplar exists

# Errors
STALE_INDEX → \`metator index build\`
`;
const skillFile = (front: Record<string, unknown> = {}, body = BODY) =>
  `---\nkind: Skill\nschemaVersion: 1\nname: mt-find-patterns\ndescription: Finds the exemplar a planned file follows. Use when a plan creates a file. Do not use for text search.\nfiles: [scripts/similar.sh]\n${Object.entries(
    front,
  )
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n${body}`;
const DIR = "metator/skills/mt-find-patterns";
const healthy = () => ({
  [`${DIR}/SKILL.md`]: skillFile(),
  [`${DIR}/scripts/similar.sh`]: '#!/bin/sh\nmetator similar "$@"\n',
});

const lint = async (files: Record<string, string>) => {
  const fs = new InMemoryFileSystem(files);
  const report = await new LintSkills(new SkillCatalog(fs, DEFAULT_PATHS), fs, "mt-").execute();
  return report._unsafeUnwrap().problems.map((p) => p.message);
};

describe("referencedFiles", () => {
  test("finds scripts, references and assets the body uses", () => {
    expect(referencedFiles("Run scripts/a.sh, read references/legacy.md and scripts/a.sh.")).toEqual([
      "references/legacy.md",
      "scripts/a.sh",
    ]);
  });
});

describe("headingsOf, namedSkills, frontMatterRule", () => {
  test("headings outside fenced code only", () => {
    expect(headingsOf("# When\n```sh\n# not a heading\n```\n## Steps\n### deep\n")).toEqual([
      { level: 1, title: "When" },
      { level: 2, title: "Steps" },
    ]);
  });

  test('skills named as "skill mt-x" or "skill `mt-x`", with the prefix only', () => {
    expect(
      namedSkills("Use skill mt-find-patterns, then Skill `mt-grill`. This skill uses mt-other.", "mt-"),
    ).toEqual(["mt-find-patterns", "mt-grill"]);
  });

  test("a broken front matter breaks the rule of its field", () => {
    expect([
      frontMatterRule("name"),
      frontMatterRule("description"),
      frontMatterRule("files.0"),
      frontMatterRule(undefined),
    ]).toEqual(["MT-SKILL-001", "MT-SKILL-002", "MT-SKILL-004", "MT-SKILL-001"]);
  });
});

const lintReport = async (files: Record<string, string>) => {
  const fs = new InMemoryFileSystem(files);
  return (await new LintSkills(new SkillCatalog(fs, DEFAULT_PATHS), fs, "mt-").execute())._unsafeUnwrap();
};
const DESCRIPTION =
  "description: Finds the exemplar a planned file follows. Use when a plan creates a file. Do not use for text search.";
const withDescription = (text: string) => ({
  ...healthy(),
  [`${DIR}/SKILL.md`]: skillFile().replace(DESCRIPTION, `description: ${text}`),
});
const withBody = (body: string, front: Record<string, unknown> = {}) => ({
  ...healthy(),
  [`${DIR}/SKILL.md`]: skillFile(front, body),
});

describe("LintSkills", () => {
  test("a healthy skill has no problems", async () => {
    expect(await lint(healthy())).toEqual([]);
  });

  test("every problem names its rule, in the message and as a field", async () => {
    const report = await lintReport({
      "metator/skills/other/SKILL.md": skillFile(),
      "metator/skills/other/scripts/similar.sh": "x",
    });
    expect(report.problems).toEqual([
      {
        source: "metator/skills/other/SKILL.md",
        skill: "mt-find-patterns",
        rule: "MT-SKILL-001",
        severity: "error",
        message: "[MT-SKILL-001] name must match its directory (other)",
      },
    ]);
  });

  describe("MT-SKILL-001 name", () => {
    test("directory, prefix, length and reserved words", async () => {
      const long = `mt-${"a".repeat(62)}`;
      const named = (name: string) => ({
        [`metator/skills/${name}/SKILL.md`]: skillFile().replace("name: mt-find-patterns", `name: ${name}`),
        [`metator/skills/${name}/scripts/similar.sh`]: "x",
      });
      expect(await lint(named("find-patterns"))).toEqual(['[MT-SKILL-001] name must start with "mt-"']);
      expect(await lint(named(long))).toEqual(["[MT-SKILL-001] name has 65 characters, at most 64"]);
      expect(await lint(named(`mt-${"a".repeat(61)}`))).toEqual([]);
      expect(await lint(named("mt-claude-anthropic"))).toEqual([
        '[MT-SKILL-001] name must not contain the reserved word "anthropic"',
        '[MT-SKILL-001] name must not contain the reserved word "claude"',
      ]);
    });

    test("a name that is not kebab-case fails the front matter, under MT-SKILL-001", async () => {
      const report = await lintReport({
        [`${DIR}/SKILL.md`]: skillFile({ name: "Mt_Find" }).replace("name: mt-find-patterns\n", ""),
      });
      expect(report.problems.map((p) => p.rule)).toEqual(["MT-SKILL-001"]);
      expect(report.problems[0]?.message).toStartWith(
        "[MT-SKILL-001] metator/skills/mt-find-patterns/SKILL.md:",
      );
    });

    test("an invalid front matter is a problem, not a crash", async () => {
      expect(
        await lint({ [`${DIR}/SKILL.md`]: "---\nkind: Skill\nschemaVersion: 1\nname: X\n---\n" }),
      ).toHaveLength(1);
    });
  });

  describe("MT-SKILL-002 description", () => {
    test("trigger and anti-trigger", async () => {
      expect(await lint(withDescription("Finds exemplars for planned files in the monorepo."))).toEqual([
        '[MT-SKILL-002] description must say when to use it ("Use when …")',
        '[MT-SKILL-002] description must say when not to use it ("Do not use …")',
      ]);
    });

    test("opens with what the skill does, in the third person", async () => {
      for (const opening of ["Use when", "Use it", "I ", "You ", "We ", "This skill", "Użyj"])
        expect(
          await lint(
            withDescription(
              `${opening} finds exemplars. Use when a plan creates a file. Do not use for search.`,
            ),
          ),
        ).toEqual([
          `[MT-SKILL-002] description must open with what the skill does, in the third person ("Finds …"), not "${opening.trim()}"`,
        ]);
      expect(
        await lint(withDescription("Inspects files. Use when a plan creates a file. Do not use for search.")),
      ).toEqual([]);
    });

    test("no XML tags: neither < nor >", async () => {
      for (const text of ["Finds <file> exemplars.", "Finds a -> b exemplars."])
        expect(
          await lint(withDescription(`${text} Use when a plan creates a file. Do not use for search.`)),
        ).toEqual(['[MT-SKILL-002] description must not contain "<" or ">" (no XML tags)']);
    });

    test("over 1024 characters fails the front matter, under MT-SKILL-002", async () => {
      const report = await lintReport(
        withDescription(`Finds ${"x".repeat(1020)}. Use when a plan creates a file. Do not use for search.`),
      );
      expect(report.problems.map((p) => p.rule)).toEqual(["MT-SKILL-002"]);
    });
  });

  describe("MT-SKILL-003 body", () => {
    test("missing sections and the line budget", async () => {
      const body = `# When\nx\n${"line\n".repeat(300)}Run scripts/similar.sh\n`;
      const problems = await lint(withBody(body));
      expect(problems).toContain('[MT-SKILL-003] missing section "# Steps" or "# Kroki"');
      expect(problems.some((p) => /^\[MT-SKILL-003\] body has \d+ lines, the budget is 300$/.test(p))).toBe(
        true,
      );
    });

    test("sections in the template's order, Polish headings too", async () => {
      const swapped = BODY.replace("# Output\npattern_source\n", "").replace(
        "# Errors",
        "# Output\npattern_source\n\n# Errors",
      );
      expect(await lint(withBody(swapped))).toEqual([
        "[MT-SKILL-003] sections must come in the order When, Steps, Output, Checklist, Errors; found When, Steps, Checklist, Output, Errors",
      ]);
      const polish = BODY.replace("# When", "# Kiedy")
        .replace("# Steps", "# Kroki")
        .replace("# Output", "# Wyjście")
        .replace("# Checklist", "# Checklista")
        .replace("# Errors", "# Błędy");
      expect(await lint(withBody(polish))).toEqual([]);
    });

    test("Steps comes right after When; subheadings of When do not count", async () => {
      expect(await lint(withBody(BODY.replace("# Steps", "# Background\nx\n\n# Steps")))).toEqual([
        '[MT-SKILL-003] "# Steps" must come right after "# When", found "# Background" between',
      ]);
      expect(await lint(withBody(BODY.replace("# Steps", "## Example\nx\n\n# Steps")))).toEqual([]);
    });

    test("a heading inside fenced code is no section", async () => {
      const fenced = BODY.replace("# Errors\n", "```md\n# Errors\n```\n");
      expect(await lint(withBody(fenced))).toEqual([
        '[MT-SKILL-003] missing section "# Errors" or "# Błędy"',
      ]);
    });
  });

  describe("MT-SKILL-004 supporting files", () => {
    test("listed files exist, used files are listed", async () => {
      const problems = await lint({
        [`${DIR}/SKILL.md`]: skillFile({}, `${BODY}Also references/legacy.md\n`),
      });
      expect(problems).toEqual([
        "[MT-SKILL-004] file scripts/similar.sh does not exist",
        "[MT-SKILL-004] uses references/legacy.md; list it in files (and ship it next to SKILL.md)",
      ]);
    });

    test("a listed file the body never names is dead weight", async () => {
      expect(await lint(withBody(BODY.replace("2. Run scripts/similar.sh\n", "")))).toEqual([
        "[MT-SKILL-004] lists scripts/similar.sh, but the body never names it; name it where a step uses it, or drop it",
      ]);
    });

    test("paths use forward slashes", async () => {
      expect(await lint(withBody(`${BODY}See references\\legacy.md\n`))).toEqual([
        "[MT-SKILL-004] uses references\\legacy.md; paths use forward slashes (references/legacy.md)",
      ]);
      const listed = {
        [`${DIR}/SKILL.md`]: skillFile().replace(
          "files: [scripts/similar.sh]",
          'files: ["scripts\\\\similar.sh", scripts/similar.sh]',
        ),
        [`${DIR}/scripts/similar.sh`]: "x",
        [`${DIR}/scripts\\similar.sh`]: "x",
      };
      expect(await lint(listed)).toEqual([
        "[MT-SKILL-004] file scripts\\similar.sh must use forward slashes (scripts/similar.sh)",
      ]);
    });

    const withReference = (reference: string, extra: Record<string, string> = {}) => ({
      [`${DIR}/SKILL.md`]: skillFile({}, `${BODY}Read references/a.md.\n`).replace(
        "files: [scripts/similar.sh]",
        "files: [scripts/similar.sh, references/a.md]",
      ),
      [`${DIR}/scripts/similar.sh`]: "x",
      [`${DIR}/references/a.md`]: reference,
      ...extra,
    });

    test("a reference names no other supporting file: one level deep", async () => {
      expect(await lint(withReference("# A\nThis file, references/a.md, is plain.\n"))).toEqual([]);
      expect(
        await lint(withReference("# A\nThen read references/b.md and run scripts/similar.sh.\n")),
      ).toEqual([
        "[MT-SKILL-004] references/a.md names references/b.md, scripts/similar.sh; a reference names no other supporting file (one level deep from SKILL.md)",
      ]);
    });

    test('a supporting .md file over 100 lines starts with "## Contents"', async () => {
      const long = (head: string) => `${head}${"line\n".repeat(100)}`;
      expect(await lint(withReference(long("# A\n")))).toEqual([
        '[MT-SKILL-004] references/a.md has 101 lines; start it with a "## Contents" heading within its first 10 lines',
      ]);
      expect(await lint(withReference(long("# A\n\n## Contents\n- x\n")))).toEqual([]);
      expect(await lint(withReference(`# A\n${"line\n".repeat(99)}`))).toEqual([]);
      expect(await lint(withReference(long(`# A\n${"x\n".repeat(9)}## Contents\n`)))).toHaveLength(1);
    });
  });

  describe("MT-SKILL-005 skills it names", () => {
    test("every skill named as skill mt-x is in the canon", async () => {
      const other = {
        "metator/skills/mt-grill/SKILL.md": skillFile({}, BODY.replace("2. Run scripts/similar.sh\n", ""))
          .replace("name: mt-find-patterns", "name: mt-grill")
          .replace("files: [scripts/similar.sh]", "files: []"),
      };
      const naming = `${BODY}Use skill mt-grill first, then skill \`mt-gone\`.\n`;
      expect(await lint({ ...withBody(naming), ...other })).toEqual([
        "[MT-SKILL-005] names skill mt-gone, which is not a skill of this repository's canon",
      ]);
    });

    test("a skill whose front matter is broken still counts as one of the canon", async () => {
      const problems = await lint({
        ...withBody(`${BODY}Use skill mt-broken.\n`),
        "metator/skills/mt-broken/SKILL.md": "---\nkind: Skill\nschemaVersion: 1\nname: X\n---\n",
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith("[MT-SKILL-001] metator/skills/mt-broken/SKILL.md:");
    });
  });
});

class FakeSkillGenerator implements SkillGenerator {
  readonly owns = "host/skills/*/SKILL.md";
  constructor(readonly host: "copilot" | "claude") {}
  skill(skill: Skill, body: string, files: readonly GeneratedFile[], context: { readonly source: string }) {
    return agentSkillLayout(
      "host/skills",
      skill,
      body,
      files,
      `<!-- generated by metator generate from ${context.source} -->`,
    );
  }
}

describe("GenerateSkills", () => {
  const gen = (
    extra: Record<string, string> = {},
    config: unknown = { hosts: { targets: ["claude"], metatorCommand: "bun run metator" } },
  ) => {
    const fs = new InMemoryFileSystem({ ...healthy(), ...extra });
    return {
      fs,
      run: new GenerateSkills(
        new SkillCatalog(fs, DEFAULT_PATHS),
        [new FakeSkillGenerator("claude")],
        fs,
        MetatorConfigSchema.parse(config),
      ),
    };
  };

  test("SKILL.md in the Agent Skills format plus its files; the repo's metator command in the body", async () => {
    const w = gen();
    expect((await w.run.execute({ check: false }))._unsafeUnwrap().written).toEqual([
      "host/skills/mt-find-patterns/scripts/similar.sh",
      "host/skills/mt-find-patterns/SKILL.md",
    ]);
    const text = (await w.fs.read("host/skills/mt-find-patterns/SKILL.md"))._unsafeUnwrap();
    expect(
      text.startsWith("---\nname: mt-find-patterns\ndescription: Finds the exemplar a planned file follows"),
    ).toBe(true);
    expect(text).toContain(`<!-- generated by metator generate from ${DIR}/SKILL.md -->`);
    expect(text).toContain("`bun run metator similar --file <path>`");
    expect(text).not.toContain("kind: Skill");
    expect((await w.run.execute({ check: true }))._unsafeUnwrap().stale).toEqual([]);
  });

  test("check mode reports edits; files of a removed skill or no longer shipped are orphans", async () => {
    const w = gen({
      "host/skills/mt-gone/SKILL.md":
        "---\nname: mt-gone\n---\n<!-- generated by metator generate from x -->\n",
      "host/skills/mt-gone/scripts/x.sh": "x",
      "host/skills/hand-made/SKILL.md": "---\nname: hand-made\n---\nmine\n",
    });
    await w.run.execute({ check: false });
    await w.fs.write("host/skills/mt-find-patterns/scripts/similar.sh", "edited");
    await w.fs.write("host/skills/mt-find-patterns/scripts/old.sh", "left over");
    const report = (await w.run.execute({ check: true }))._unsafeUnwrap();
    expect(report.stale).toEqual(["host/skills/mt-find-patterns/scripts/similar.sh"]);
    expect(report.orphaned).toEqual([
      "host/skills/mt-find-patterns/scripts/old.sh",
      "host/skills/mt-gone/SKILL.md",
      "host/skills/mt-gone/scripts/x.sh",
    ]);
  });

  test("hosts not targeted get nothing; an invalid skill stops generation", async () => {
    expect(
      (await gen({}, { hosts: { targets: ["copilot"] } }).run.execute({ check: false }))._unsafeUnwrap()
        .written,
    ).toEqual([]);
    const bad = gen({ "metator/skills/mt-bad/SKILL.md": "---\nkind: Skill\nschemaVersion: 1\n---\n" });
    expect((await bad.run.execute({ check: false }))._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });
});
