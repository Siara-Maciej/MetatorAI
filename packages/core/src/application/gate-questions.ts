import { parseMrUrl } from "../domain/codehost.ts";
import { gateQuestion, type Question } from "../domain/drive.ts";
import type { MetatorError } from "../domain/errors.ts";
import { ok, type Result } from "../domain/result.ts";
import { toComments, VerdictDocument } from "../domain/verdict.ts";
import { publishPrompt } from "../domain/watched-review.ts";
import type { StageSpec } from "../domain/workflow-spec.ts";
import type { FileSystem } from "../ports/index.ts";
import { decisionCard } from "./decision-card.ts";
import { loadDocument } from "./document-io.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/**
 * A human gate's question, the same from every front: what is approved for which task
 * (`gateQuestion`) and the two answers. A gate that publishes a review asks it as the publish
 * card (`publish`, ADR-0097): Approve is Yes. `before` is the stage the run passed last.
 */
export const gateQuestionOf = (
  stage: Pick<StageSpec, "id" | "description" | "grants">,
  task: string,
  before?: string,
  publish?: string,
) => ({
  stage: stage.id,
  source: "gate" as const,
  prompt: publish ?? gateQuestion(stage, task, before),
  options: publish
    ? [
        { label: "Approve", description: "Yes: publish the whole review, inline where the host allows" },
        { label: "Reject", description: "No: keep it in the chat; nothing is posted" },
      ]
    : [
        { label: "Approve", description: "Continue with the next stage" },
        { label: "Reject", description: "Send the run back, with your reason" },
      ],
  multiSelect: false,
});

/**
 * The publish card's question (ADR-0097): at a gate that grants `comment`, once the verdict is
 * there, "Publish the review of MR #45? (3 inline comments, 1 general)"; undefined otherwise.
 */
export async function publishQuestion(
  fs: FileSystem,
  runDir: string,
  stage: Pick<StageSpec, "grants">,
  inputs: Readonly<Record<string, string>> | undefined,
): Promise<string | undefined> {
  if (!(stage.grants ?? []).includes("comment")) return undefined;
  const verdict = await loadDocument(fs, `${runDir}/verdict.json`, VerdictDocument, "json");
  if (verdict.isErr()) return undefined;
  const pr = inputs?.pr ? parseMrUrl(inputs.pr) : undefined;
  return publishPrompt(
    pr?.isOk() ? pr.value.number : undefined,
    toComments(verdict.value, "labeled").comments.length,
    verdict.value.consider.length,
  );
}

export interface GateQuestionDependencies {
  readonly catalog: Pick<WorkflowCatalog, "get">;
  readonly repo: Pick<RunRepository, "load" | "runDir">;
  readonly journal: Pick<RunJournal, "ask" | "activity">;
  readonly fs: FileSystem;
  /** Where gate reports are (`paths.gates`), for the card's evidence. */
  readonly gatesDir?: string;
}

/**
 * A run that stands at a human gate has its question in the journal, whoever moved it there (a
 * drive, a conductor's `run advance`, a person): so the inbox shows the approval card and its
 * answer decides the gate. One question per visit of the stage: asking again finds it.
 */
export class GateQuestions {
  constructor(private readonly d: GateQuestionDependencies) {}

  async ask(runId: string): Promise<Result<Question | undefined, MetatorError>> {
    const record = await this.d.repo.load(runId);
    if (record.isErr() || record.value.state.status !== "active") return ok(undefined);
    const entry = await this.d.catalog.get(record.value.workflow.id);
    if (entry.isErr()) return ok(undefined);
    const stages = entry.value.spec.stages;
    const stage = stages.find((s) => s.id === record.value.state.stage);
    if (!stage?.hitl) return ok(undefined);
    const history = record.value.state.context.history;
    const done = [
      ...new Set(history.filter((h) => h.event === "PASS" || h.event === "APPROVE").map((h) => h.stage)),
    ];
    const card = await decisionCard(
      { fs: this.d.fs, repo: this.d.repo, journal: this.d.journal, gatesDir: this.d.gatesDir },
      {
        runId,
        task: record.value.task,
        stage,
        done,
        stages,
        loops: record.value.state.context.loops,
        loopLimits: entry.value.spec.loops ?? {},
        children: record.value.children ?? [],
      },
      {
        // The stage before passed its checks: the evidence points to approving. A gate that grants
        // an external action (the push) starts something approving cannot take back.
        ...(history.at(-1)?.event === "PASS" ? { recommended: "Approve" } : {}),
        reversible: (stage.grants ?? []).length === 0,
      },
    );
    // Since the run's last change: an answer given before it was for an earlier visit.
    const publish = await publishQuestion(this.d.fs, this.d.repo.runDir(runId), stage, record.value.inputs);
    return this.d.journal.ask(
      runId,
      { ...gateQuestionOf(stage, record.value.task, done.at(-1), publish), card },
      record.value.updatedAt,
    );
  }
}
