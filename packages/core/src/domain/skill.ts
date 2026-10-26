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
