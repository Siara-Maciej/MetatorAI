import { z } from "zod";
import { renderCitation } from "./memory.ts";
import { defineDocument, renderFrontMatter } from "./versioned.ts";

/**
 * A lesson (T4, `lessons add`): one statement learned from a run, approved by a human, with a
 * citation that `memory validate` keeps true (03-memory-map: no citation, no lesson).
 */
export const LessonSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  createdAt: z.iso.datetime(),
  /** The run it was learned from. */
  run: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
});
export type Lesson = z.output<typeof LessonSchema>;

export const LessonDocument = defineDocument("Lesson", {
  latest: LessonSchema,
  hint: "Add lessons with `metator lessons add`; the citation must point at real code.",
});

export function renderLesson(
  lesson: Lesson,
  statement: string,
  citation: { readonly path: string; readonly line: number; readonly quote: string },
): string {
  return renderFrontMatter(
    LessonDocument.stamp(lesson),
    `# ${lesson.title}\n\n${statement.trim()}\n\nEvidence: ${renderCitation(citation)}\n`,
  );
}
