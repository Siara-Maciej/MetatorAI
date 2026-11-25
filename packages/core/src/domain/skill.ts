import { z } from "zod";
import { defineDocument, renderYamlFields } from "./versioned.ts";

/**
 * Canonical skill (ADR-0039): `metator/skills/<name>/SKILL.md`, host-neutral. Host plugins copy it
 * to `.claude/skills/<name>/` and `.github/skills/<name>/` in the Agent Skills format, with its
 * supporting files (scripts, references).
 */
export const SkillSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "expected a kebab-case name, e.g. mt-find-patterns"),
  /** When to use the skill and when not: hosts load skills by this text. */
  description: z.string().min(20).max(1024),
  /** Supporting files next to SKILL.md (relative paths), e.g. scripts/similar.sh. */
  files: z.array(z.string().min(1)).default([]),
});
export type Skill = z.output<typeof SkillSchema>;

export const SkillDocument = defineDocument("Skill", {
  latest: SkillSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the skill's front matter; `metator meta skills-schema` prints the JSON Schema.",
});

/** Sections every skill body has (05-templates §3), English or Polish headings. */
export const SKILL_SECTIONS: readonly (readonly string[])[] = [
  ["When", "Kiedy"],
  ["Steps", "Kroki"],
  ["Output", "Wyjście"],
  ["Checklist", "Checklista"],
  ["Errors", "Błędy"],
];

export const SKILL_BODY_LINES = 300;

/** The description says when to use the skill and when not (trigger and anti-trigger). */
export const TRIGGER = /\b(use when|use it when|użyj,? gdy|użyj,? kiedy)\b/i;
export const ANTI_TRIGGER = /\b(do not use|don't use|not for|nie używaj)\b/i;

/** Files a body points at (`scripts/x.sh`, `references/y.md`): they must ship with the skill. */
export function referencedFiles(body: string): string[] {
  return [
    ...new Set(
      [...body.matchAll(/\b((?:scripts|references|assets)\/[\w./-]+\w)/g)].map((m) => m[1] as string),
    ),
  ].sort();
}

/**
 * The canon rules a skill is linted against (`docs/metator/rules/skill.yml`): 001 name, 002
 * description, 003 body, 004 supporting files, 005 skills it names.
 */
export type SkillRuleId = "MT-SKILL-001" | "MT-SKILL-002" | "MT-SKILL-003" | "MT-SKILL-004" | "MT-SKILL-005";

export interface SkillFinding {
  readonly rule: SkillRuleId;
  /** `[MT-SKILL-00N] …`: the message names its rule. */
  readonly message: string;
}

/** Agent Skills spec: a name has at most 64 characters and no reserved word. */
export const SKILL_NAME_MAX = 64;
export const RESERVED_WORDS: readonly string[] = ["anthropic", "claude"];

/**
 * The description is injected into the system prompt, so it opens with what the skill does in
 * the third person ("Finds …"), never with the trigger or a pronoun.
 */
export const DESCRIPTION_OPENING = /^\s*(use when|use it\b|użyj\b|i |you |we |this skill\b)/i;

/** A supporting Markdown file longer than this starts with a table of contents. */
export const SKILL_FILE_TOC_LINES = 100;
/** …a `## Contents` heading within its first lines. */
export const SKILL_FILE_TOC_WITHIN = 10;
const CONTENTS = /^##\s+(contents|spis treści)\s*$/i;

/** The rule a front matter that does not parse breaks, from the field its first issue names. */
export function frontMatterRule(path: string | undefined): SkillRuleId {
  const field = path?.split(".")[0];
  if (field === "description") return "MT-SKILL-002";
  if (field === "files") return "MT-SKILL-004";
  return "MT-SKILL-001";
}

/** The `#` and `##` headings of a Markdown text, outside fenced code. */
export function headingsOf(text: string): { readonly level: number; readonly title: string }[] {
  const out: { level: number; title: string }[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: (m[1] as string).length, title: m[2] as string });
  }
  return out;
}

/** Skills a text refers to as "skill mt-x" or "skill `mt-x`" (names with the repository's prefix). */
export function namedSkills(text: string, prefix: string): string[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bskill\\s+\`?(${escaped}[a-z0-9-]*[a-z0-9])\`?`, "gi");
  return [...new Set([...text.matchAll(pattern)].map((m) => (m[1] as string).toLowerCase()))].sort();
}

export interface SkillLintContext {
  readonly prefix: string;
  /** The name of the directory SKILL.md sits in. */
  readonly dir: string;
  /** Each file the front matter lists, with its text; undefined when it does not exist. */
  readonly files: ReadonlyMap<string, string | undefined>;
  /** Every skill of the repository's canon. */
  readonly skills: ReadonlySet<string>;
}

/** Every way a skill breaks the rules MT-SKILL-001..005. */
export function lintSkill(skill: Skill, body: string, ctx: SkillLintContext): SkillFinding[] {
  const out: SkillFinding[] = [];
  const problem = (rule: SkillRuleId, message: string) => out.push({ rule, message: `[${rule}] ${message}` });

  // MT-SKILL-001: name (kebab-case is the front matter's own schema).
  if (ctx.dir !== skill.name) problem("MT-SKILL-001", `name must match its directory (${ctx.dir})`);
  if (!skill.name.startsWith(ctx.prefix)) problem("MT-SKILL-001", `name must start with "${ctx.prefix}"`);
  if (skill.name.length > SKILL_NAME_MAX)
    problem("MT-SKILL-001", `name has ${skill.name.length} characters, at most ${SKILL_NAME_MAX}`);
  for (const word of RESERVED_WORDS)
    if (skill.name.includes(word))
      problem("MT-SKILL-001", `name must not contain the reserved word "${word}"`);

  // MT-SKILL-002: description (its length is the front matter's own schema).
  const opening = DESCRIPTION_OPENING.exec(skill.description)?.[1];
  if (opening !== undefined)
    problem(
      "MT-SKILL-002",
      `description must open with what the skill does, in the third person ("Finds …"), not "${opening.trim()}"`,
    );
  if (/[<>]/.test(skill.description))
    problem("MT-SKILL-002", 'description must not contain "<" or ">" (no XML tags)');
  if (!TRIGGER.test(skill.description))
    problem("MT-SKILL-002", 'description must say when to use it ("Use when …")');
  if (!ANTI_TRIGGER.test(skill.description))
    problem("MT-SKILL-002", 'description must say when not to use it ("Do not use …")');

  // MT-SKILL-003: the template's sections, in order, Steps right after When; the line budget.
  const headings = headingsOf(body);
  const at = SKILL_SECTIONS.map((names) =>
    headings.findIndex((h) => names.some((n) => n.toLowerCase() === h.title.toLowerCase())),
  );
  SKILL_SECTIONS.forEach((names, i) => {
    if (at[i] === -1) problem("MT-SKILL-003", `missing section "# ${names.join('" or "# ')}"`);
  });
  const present = at.map((index, i) => ({ index, i })).filter((s) => s.index >= 0);
  const ordered = present.every((s, k) => k === 0 || (present[k - 1] as { index: number }).index < s.index);
  if (!ordered)
    problem(
      "MT-SKILL-003",
      `sections must come in the order ${SKILL_SECTIONS.map((n) => n[0]).join(", ")}; found ${[...present]
        .sort((a, b) => a.index - b.index)
        .map((s) => SKILL_SECTIONS[s.i]?.[0])
        .join(", ")}`,
    );
  const when = at[0] as number;
  const steps = at[1] as number;
  if (ordered && when >= 0 && steps >= 0) {
    const level = (headings[when] as { level: number }).level;
    const next = headings.slice(when + 1).find((h) => h.level <= level);
    if (next !== headings[steps])
      problem(
        "MT-SKILL-003",
        `"# Steps" must come right after "# When", found ${next ? `"# ${next.title}"` : "no heading at its level"} between`,
      );
  }
  const lines = body.trimEnd().split("\n").length;
  if (lines > SKILL_BODY_LINES)
    problem("MT-SKILL-003", `body has ${lines} lines, the budget is ${SKILL_BODY_LINES}`);

  // MT-SKILL-004: supporting files.
  for (const [f, text] of ctx.files) {
    if (text === undefined) problem("MT-SKILL-004", `file ${f} does not exist`);
    if (f.includes("\\"))
      problem("MT-SKILL-004", `file ${f} must use forward slashes (${f.replaceAll("\\", "/")})`);
    else if (!body.includes(f))
      problem(
        "MT-SKILL-004",
        `lists ${f}, but the body never names it; name it where a step uses it, or drop it`,
      );
    if (text === undefined || !f.endsWith(".md")) continue;
    const others = [
      ...new Set([...referencedFiles(text), ...skill.files.filter((g) => text.includes(g))]),
    ].filter((g) => g !== f);
    if (others.length > 0)
      problem(
        "MT-SKILL-004",
        `${f} names ${others.join(", ")}; a reference names no other supporting file (one level deep from SKILL.md)`,
      );
    const fileLines = text.trimEnd().split("\n");
    if (
      fileLines.length > SKILL_FILE_TOC_LINES &&
      !fileLines.slice(0, SKILL_FILE_TOC_WITHIN).some((l) => CONTENTS.test(l.trim()))
    )
      problem(
        "MT-SKILL-004",
        `${f} has ${fileLines.length} lines; start it with a "## Contents" heading within its first ${SKILL_FILE_TOC_WITHIN} lines`,
      );
  }
  for (const m of body.matchAll(/\b((?:scripts|references|assets)\\[\w.\\-]*\w)/g))
    problem(
      "MT-SKILL-004",
      `uses ${m[1]}; paths use forward slashes (${(m[1] as string).replaceAll("\\", "/")})`,
    );
  for (const f of referencedFiles(body))
    if (!ctx.files.has(f))
      problem("MT-SKILL-004", `uses ${f}; list it in files (and ship it next to SKILL.md)`);

  // MT-SKILL-005: every skill it names is in the canon.
  for (const name of namedSkills(`${skill.description}\n${body}`, ctx.prefix))
    if (!ctx.skills.has(name))
      problem("MT-SKILL-005", `names skill ${name}, which is not a skill of this repository's canon`);
  return out;
}

/** The Agent Skills layout both hosts read: `<root>/<name>/SKILL.md` plus the skill's files. */
export function agentSkillLayout(
  root: string,
  skill: Skill,
  body: string,
  files: readonly { readonly path: string; readonly content: string }[],
  marker: string,
): { readonly path: string; readonly content: string }[] {
  const dir = `${root}/${skill.name}`;
  const front = renderYamlFields({ name: skill.name, description: skill.description });
  const text = body.startsWith("\n") ? body : `\n${body}`;
  return [
    { path: `${dir}/SKILL.md`, content: `---\n${front}\n---\n${marker}\n${text}` },
    ...files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content })),
  ];
}
