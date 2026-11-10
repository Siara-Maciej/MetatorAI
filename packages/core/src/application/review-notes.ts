import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  isReviewReply,
  nextNoteId,
  notesMessage,
  notesRefs,
  type ReviewNote,
  ReviewNotesDocument,
} from "../domain/review-note.ts";
import type { RunMessage } from "../domain/run-message.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import type { RunMessages } from "./run-messages.ts";
import type { RunRepository } from "./run-repository.ts";

export interface ReviewNotesDependencies {
  readonly fs: FileSystem;
  readonly repo: Pick<RunRepository, "resolveId" | "runDir">;
  readonly messages: Pick<RunMessages, "send" | "list">;
  readonly clock: Clock;
}

export interface AddNoteInput {
  readonly file?: string;
  readonly line?: number;
  readonly side?: "old" | "new";
  readonly text: string;
  readonly by: string;
}

/**
 * A person's notes on a run's change (S5): kept per run, sent to the run's agents as one message
 * (topic `review`) when the person says so; a reply (topic `review-reply`) marks the sent notes
 * addressed, which the person confirms by hand too.
 */
export class ReviewNotes {
  constructor(private readonly d: ReviewNotesDependencies) {}

  async list(
    runId?: string,
  ): Promise<Result<{ readonly runId: string; readonly notes: readonly ReviewNote[] }, MetatorError>> {
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const notes = await this.load(id.value);
    if (notes.isErr()) return err(notes.error);
    const replies = await this.d.messages.list(id.value);
    if (replies.isErr()) return err(replies.error);
    return ok({ runId: id.value, notes: withReplies(notes.value, replies.value) });
  }

  async add(runId: string | undefined, input: AddNoteInput): Promise<Result<ReviewNote, MetatorError>> {
    if (input.text.trim() === "") return err(usage("a note needs a text"));
    if (input.by.trim() === "") return err(usage("say who writes the note: --by <name>"));
    if (input.line !== undefined && !input.file) return err(usage("a line needs a file"));
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const notes = await this.load(id.value);
    if (notes.isErr()) return err(notes.error);
    const note: ReviewNote = {
      id: nextNoteId(notes.value.map((n) => n.id)),
      ...(input.file ? { file: input.file } : {}),
      ...(input.line ? { line: input.line } : {}),
      ...(input.side ? { side: input.side } : {}),
      text: input.text,
      by: input.by,
      at: this.d.clock.now().toISOString(),
      status: "draft",
    };
    const saved = await this.save(id.value, [...notes.value, note]);
    return saved.map(() => note);
  }

  /** The draft notes go to the run as one message; each note remembers the message and is `sent`. */
  async send(
    runId: string | undefined,
    input: { readonly by: string },
  ): Promise<Result<{ readonly message: RunMessage; readonly notes: readonly ReviewNote[] }, MetatorError>> {
    if (input.by.trim() === "") return err(usage("say who sends: --by <name>"));
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const notes = await this.load(id.value);
    if (notes.isErr()) return err(notes.error);
    const drafts = notes.value.filter((n) => n.status === "draft");
    if (drafts.length === 0) return err(usage("no draft notes to send"));
    const message = await this.d.messages.send({
      from: id.value,
      to: id.value,
      topic: "review",
      text: notesMessage(drafts),
      refs: notesRefs(drafts),
      by: input.by,
    });
    if (message.isErr()) return err(message.error);
    const sent = notes.value.map((n) =>
      n.status === "draft" ? { ...n, status: "sent" as const, sentIn: message.value.id } : n,
    );
    const saved = await this.save(id.value, sent);
    if (saved.isErr()) return err(saved.error);
    return ok({ message: message.value, notes: sent.filter((n) => n.sentIn === message.value.id) });
  }

  /** The person confirms a note is addressed (or reopens it as a draft). */
  async setStatus(
    runId: string | undefined,
    noteId: string,
    status: ReviewNote["status"],
  ): Promise<Result<ReviewNote, MetatorError>> {
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const notes = await this.load(id.value);
    if (notes.isErr()) return err(notes.error);
    const found = notes.value.find((n) => n.id === noteId);
    if (!found) return err(notFound(`note ${noteId}`));
    const next: ReviewNote =
      status === "draft" ? { ...found, status, sentIn: undefined } : { ...found, status };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as ReviewNote;
    const saved = await this.save(
      id.value,
      notes.value.map((n) => (n.id === noteId ? clean : n)),
    );
    return saved.map(() => clean);
  }

  private file(runId: string): string {
    return `${this.d.repo.runDir(runId)}/review/notes.json`;
  }

  private async load(runId: string): Promise<Result<ReviewNote[], MetatorError>> {
    const file = this.file(runId);
    if (!(await this.d.fs.exists(file))) return ok([]);
    const text = await this.d.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file)
      .andThen((raw) => ReviewNotesDocument.parse(raw, file))
      .map((d) => [...d.notes]);
  }

  private save(runId: string, notes: readonly ReviewNote[]): Promise<Result<void, MetatorError>> {
    return this.d.fs.write(
      this.file(runId),
      serializeJsonDocument(ReviewNotesDocument.stamp({ notes: [...notes] })),
    );
  }
}

/** Sent notes whose message got a review reply read as addressed (the file is not rewritten: the person confirms). */
export function withReplies(notes: readonly ReviewNote[], messages: readonly RunMessage[]): ReviewNote[] {
  const replied = new Set(
    messages.filter(isReviewReply).flatMap((m) => m.refs.filter((r) => /^m\d{3,}$/.test(r))),
  );
  return notes.map((n) =>
    n.status === "sent" && n.sentIn && replied.has(n.sentIn) ? { ...n, status: "addressed" } : n,
  );
}

const usage = (message: string) => MetatorError.usage(message);
const notFound = (what: string) => MetatorError.notFound(what);
