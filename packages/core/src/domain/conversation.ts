import { z } from "zod";
import { slug } from "./ids.ts";
import { defineDocument } from "./versioned.ts";

/**
 * A conversation with `mt-guide` (G3, ADR-0058): plain questions about the code, each answered
 * with `path:line` citations; `.metator/conversations/<id>.json`. A follow-up continues the host's
 * session when the host has one.
 */
export const CONVERSATION_ID = /^[0-9]{8}-[a-z0-9-]{1,60}$/;

const AnswerCitationSchema = z.strictObject({
  path: z.string().min(1),
  line: z.number().int().positive(),
  /** Whether the cited file exists: a cited file that does not is flagged to the person. */
  exists: z.boolean(),
});
export type AnswerCitation = z.output<typeof AnswerCitationSchema>;

const TurnSchema = z.strictObject({
  at: z.iso.datetime(),
  by: z.string().min(1),
  question: z.string().min(1),
  answer: z.string(),
  ok: z.boolean(),
  citations: z.array(AnswerCitationSchema),
});
export type Turn = z.output<typeof TurnSchema>;

export const ConversationSchema = z.strictObject({
  id: z.string().regex(CONVERSATION_ID),
  title: z.string().min(1),
  host: z.string().min(1),
  /** The host's session to continue (Claude Code session id, Copilot session, scenario start). */
  hostSession: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  turns: z.array(TurnSchema),
});
export type Conversation = z.output<typeof ConversationSchema>;

export const ConversationDocument = defineDocument("Conversation", {
  latest: ConversationSchema,
  hint: "Written by `metator ask`; continue it with `metator ask --conversation <id> …`.",
});

/** The id of a new conversation: the day and the question's first words. */
export function conversationId(question: string, at: Date, taken: (id: string) => boolean): string {
  const day = at.toISOString().slice(0, 10).replaceAll("-", "");
  const base = `${day}-${slug(question, 40, "question")}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Every `path:line` (or `path:line-line`) in an answer, first mention first. Next.js segments
 * (`app/[locale]/(protected)/layout.tsx`) are paths too. A bare file name (`registry.ts:36`) after
 * its full path was cited means that file: the one mentioned last with that name.
 */
export function findCitations(answer: string): { path: string; line: number }[] {
  const seen = new Set<string>();
  const out: { path: string; line: number }[] = [];
  const segment = String.raw`(?:\[[\w.-]+\]|\([\w.-]+\)|[\w@.-]+)`;
  const re = new RegExp(
    String.raw`(?<![\w/.-])((?:\.{0,2}\/)?(?:${segment}\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-\d+)?\b`,
    "g",
  );
  const full = new Map<string, string>(); // file name → the full path mentioned last
  for (const m of answer.matchAll(re)) {
    let path = (m[1] as string).replace(/^\.\//, "");
    if (path.includes("/")) full.set(path.slice(path.lastIndexOf("/") + 1), path);
    else path = full.get(path) ?? path;
    const line = Number(m[2]);
    const key = `${path}:${line}`;
    if (line > 0 && !seen.has(key) && !/^https?:/.test(path)) {
      seen.add(key);
      out.push({ path, line });
    }
  }
  return out;
}

const RULES =
  "Read the code; change nothing. Cite every claim as path:line (relative to the directory you are in). Say plainly when the code does not settle something.";

/**
 * What mt-guide is asked. A continued host session already knows the conversation; without one,
 * the last turns go along so a follow-up still has its context.
 */
export function guidePrompt(
  question: string,
  where: string,
  history: readonly Turn[],
  resumed: boolean,
): string {
  if (resumed) return `${question}\n\n(${RULES})`;
  const earlier = history
    .slice(-3)
    .map((t) => `Q: ${t.question}\nA: ${t.answer}`)
    .join("\n\n");
  return [
    `A question about the code in ${where}. ${RULES}`,
    ...(earlier ? [`Earlier in this conversation:\n${earlier}`] : []),
    `Question: ${question}`,
  ].join("\n\n");
}
