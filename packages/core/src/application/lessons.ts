import slugify from "@sindresorhus/slugify";
import { MetatorError } from "../domain/errors.ts";
import { type Lesson, renderLesson } from "../domain/lesson.ts";
import { locateQuote } from "../domain/memory.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock, FileSystem } from "../ports/index.ts";

export interface AddLessonInput {
  readonly title: string;
  readonly statement: string;
  readonly cite: { readonly path: string; readonly line: number; readonly quote: string };
  readonly run?: string;
  readonly tags?: readonly string[];
}

/**
 * `lessons add` (ADR-0044): writes a lesson to the lessons directory only when its citation is
 * true now; a quote that moved is written with the line it is really on.
 */
export class AddLesson {
  constructor(
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly dir: string,
  ) {}

  async execute(
    input: AddLessonInput,
  ): Promise<
    Result<{ readonly file: string; readonly lesson: Lesson; readonly line: number }, MetatorError>
  > {
    const code = await this.fs.read(input.cite.path);
    if (code.isErr())
      return err(new MetatorError("NOT_FOUND", `cited file ${input.cite.path} does not exist`));
    const match = locateQuote(code.value, input.cite.line, input.cite.quote);
    if (match.status === "stale") {
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `quote not found in ${input.cite.path} near line ${input.cite.line}`,
          {
            hint: "A lesson needs evidence: cite a line that holds the quote (whitespace is normalized).",
          },
        ),
      );
    }
    const id = slugify(input.title).slice(0, 60).replace(/-+$/, "") || "lesson";
    const file = `${this.dir}/${id}.md`;
    if (await this.fs.exists(file))
      return err(
        MetatorError.usage(`lesson ${file} already exists`, "Choose another title or edit that lesson."),
      );
    const lesson: Lesson = {
      id,
      title: input.title,
      createdAt: this.clock.now().toISOString(),
      ...(input.run === undefined ? {} : { run: input.run }),
      tags: [...(input.tags ?? [])],
    };
    const written = await this.fs.write(
      file,
      renderLesson(lesson, input.statement, { ...input.cite, line: match.line }),
    );
    if (written.isErr()) return err(written.error);
    return ok({ file, lesson, line: match.line });
  }
}
