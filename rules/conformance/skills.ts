import {
  DEFAULT_PATHS,
  err,
  LintSkills,
  MetatorError,
  ok,
  type ReadonlyFileSystem,
  SkillCatalog,
  type SkillRuleId,
} from "../../packages/core/src/index.ts";
import { files, read } from "./lib.ts";

/** The skills' files, as a read-only file system the lint can scan. */
function filesOf(skills: Readonly<Record<string, string>>): ReadonlyFileSystem {
  const paths = Object.keys(skills).sort();
  return {
    read: async (path) => {
      const text = skills[path];
      return text === undefined ? err(MetatorError.notFound(`File ${path}`, { path })) : ok(text);
    },
    exists: async (path) => skills[path] !== undefined,
    glob: async (patterns) => paths.filter((p) => patterns.some((g) => new Bun.Glob(g).match(p))),
  };
}

/** The repository's canonical skills, every file under metator/skills, as they are on disk. */
export async function canonSkills(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await files(`${DEFAULT_PATHS.skills}/**/*`)) out[f] = await read(f);
  return out;
}

/**
 * `meta skills-lint` on the given skills (MT-SKILL-001..005): the problems of one rule, as
 * `<source>: <message>`. The conformance tests run it on the canon, and on the canon with a
 * skill broken on purpose.
 */
export async function skillProblems(rule: SkillRuleId, skills: Record<string, string>): Promise<string[]> {
  const fs = filesOf(skills);
  const report = await new LintSkills(new SkillCatalog(fs, DEFAULT_PATHS), fs, "mt-").execute();
  if (report.isErr()) return [report.error.message];
  return report.value.problems.filter((p) => p.rule === rule).map((p) => `${p.source}: ${p.message}`);
}

/** A skill that passes every rule, for a test to break one way. */
export const SOUND_SKILL = `---
kind: Skill
schemaVersion: 1
name: mt-sound
description: Finds the answer to a sound question. Use when a question is sound. Do not use for anything else.
---
# When
A question is sound.

# Steps
1. Answer it.

# Output
The answer.

# Checklist
- [ ] answered

# Errors
None.
`;
