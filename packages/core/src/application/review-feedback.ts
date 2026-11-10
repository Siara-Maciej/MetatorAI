import type { MetatorError } from "../domain/errors.ts";
import { renderReportHtml } from "../domain/report-render.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type ReactionStats,
  type ReviewReaction,
  ReviewReactionDocument,
  reactionStats,
} from "../domain/review-feedback.ts";
import { parseJsonDocument, serializeJsonLine } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { BuildReport } from "./report.ts";

/** `metator findings react` and the reactions part of `metator report` (F5 telemetry). */
export class ReviewFeedback {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: Pick<MetatorPaths, "telemetry">,
    private readonly clock: Clock,
  ) {}

  file(): string {
    return `${this.paths.telemetry}/reactions.jsonl`;
  }

  async record(input: Omit<ReviewReaction, "at">): Promise<Result<ReviewReaction, MetatorError>> {
    const parsed = ReviewReactionDocument.parse(
      ReviewReactionDocument.stamp({ at: this.clock.now().toISOString(), ...input }),
      this.file(),
    );
    if (parsed.isErr()) return err(parsed.error);
    const appended = await this.fs.append(
      this.file(),
      serializeJsonLine(ReviewReactionDocument.stamp(parsed.value)),
    );
    return appended.map(() => parsed.value);
  }

  async list(): Promise<Result<readonly ReviewReaction[], MetatorError>> {
    const file = this.file();
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const out: ReviewReaction[] = [];
    for (const line of text.value.split("\n").filter((l) => l.trim() !== "")) {
      const r = parseJsonDocument(line, file).andThen((raw) => ReviewReactionDocument.parse(raw, file));
      if (r.isErr()) return err(r.error);
      out.push(r.value);
    }
    return ok(out);
  }

  async stats(): Promise<Result<ReactionStats, MetatorError>> {
    return (await this.list()).map(reactionStats);
  }
}

/** `metator report --html <file>`: the fleet report and the reactions as one page. */
export class RenderReport {
  constructor(
    private readonly report: BuildReport,
    private readonly feedback: ReviewFeedback,
    private readonly fs: Pick<FileSystem, "write">,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly out: string;
    readonly since?: string;
  }): Promise<
    Result<
      { readonly output: string; readonly bytes: number; readonly runs: number; readonly reactions: number },
      MetatorError
    >
  > {
    const fleet = await this.report.execute(input.since);
    if (fleet.isErr()) return err(fleet.error);
    const reactions = await this.feedback.stats();
    if (reactions.isErr()) return err(reactions.error);
    const html = renderReportHtml(fleet.value, reactions.value, this.clock.now());
    const saved = await this.fs.write(input.out, html);
    if (saved.isErr()) return err(saved.error);
    return ok({
      output: input.out,
      bytes: html.length,
      runs: fleet.value.runs.length,
      reactions: reactions.value.total,
    });
  }
}
