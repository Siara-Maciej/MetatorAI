import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { nextMessageId, type RunMessage, RunMessageDocument } from "../domain/run-message.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";
import type { RunJournal } from "./drive.ts";
import type { RunRepository } from "./run-repository.ts";

export interface SendMessageInput {
  readonly from: string;
  readonly to: string;
  readonly topic: RunMessage["topic"];
  readonly text: string;
  readonly refs?: readonly string[];
  readonly by: string;
}

/**
 * Messages between runs (D2, ADR-0077): `.metator/runs/<to>/messages/<id>.json`. Both runs note
 * it in their activity; the receiving run's agents read it as data at their next stage.
 */
export class RunMessages {
  constructor(
    private readonly fs: FileSystem,
    private readonly repo: RunRepository,
    private readonly journal: Pick<RunJournal, "record">,
    private readonly clock: Clock,
  ) {}

  file(runId: string, id: string): string {
    return `${this.repo.runDir(runId)}/messages/${id}.json`;
  }

  async list(runId: string): Promise<Result<readonly RunMessage[], MetatorError>> {
    const files = await this.fs.glob([`${this.repo.runDir(runId)}/messages/m*.json`]);
    const out: RunMessage[] = [];
    for (const file of files) {
      const m = await loadDocument(this.fs, file, RunMessageDocument, "json");
      if (m.isErr()) return err(m.error);
      out.push(m.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
  }

  async send(input: SendMessageInput): Promise<Result<RunMessage, MetatorError>> {
    for (const runId of [input.from, input.to]) {
      const known = await this.repo.load(runId);
      if (known.isErr()) return err(known.error);
    }
    const existing = await this.list(input.to);
    if (existing.isErr()) return err(existing.error);
    const message: RunMessage = {
      id: nextMessageId(existing.value.map((m) => m.id)),
      fromRun: input.from,
      toRun: input.to,
      at: this.clock.now().toISOString(),
      topic: input.topic,
      text: input.text,
      refs: [...(input.refs ?? [])],
      by: input.by,
    };
    const saved = await writeDocument(
      this.fs,
      this.file(input.to, message.id),
      RunMessageDocument,
      message,
      "json",
    );
    if (saved.isErr()) return err(saved.error);
    const summary = `${message.topic}: ${message.text.slice(0, 200)}`;
    const noted = await this.journal.record(input.to, {
      type: "message",
      origin: "run",
      text: `${message.id} from ${input.from} · ${summary}`,
    });
    if (noted.isErr()) return err(noted.error);
    const sent = await this.journal.record(input.from, {
      type: "message",
      origin: "run",
      text: `${message.id} to ${input.to} · ${summary}`,
    });
    if (sent.isErr()) return err(sent.error);
    return ok(message);
  }
}
