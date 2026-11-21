import { z } from "zod";
import type { MetatorError } from "../domain/errors.ts";
import { digestOf } from "../domain/ids.ts";
import { err, type Result } from "../domain/result.ts";
import { defineDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";

/** Who a line typed into a pane came from: MetatorAI itself, or a person's answer typed for them. */
export type TypedBy = "metator" | "answer";

/**
 * What the daemon typed into a pane lately (`.metator/typed/<pane>.json`): a hash and a time per
 * line, never the words. A host reports every submitted line to its user-prompt hook, the
 * daemon's too; the hook and the daemon read this to tell them from the person's own typing.
 */
export const PaneTypedDocument = defineDocument("PaneTyped", {
  latest: z.strictObject({
    lines: z.array(
      z.strictObject({
        hash: z.string().min(1),
        at: z.iso.datetime(),
        /** `metator`: a relay, a nudge, a notice. `answer`: a person's answer to a card, typed for them. */
        by: z.enum(["metator", "answer"]),
      }),
    ),
  }),
  hint: "Written by the daemon when it types into a pane; never by hand or by an agent.",
});

/** How long a typed line is remembered, and how many per pane. */
const KEPT_MS = 30 * 60_000;
const KEPT_LINES = 40;

const fileOf = (paneId: string): string => `.metator/typed/${paneId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;

/** The words as a host may hand them back: control characters gone, runs of space one space. */
export const typedDigest = (text: string): string =>
  digestOf(
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

export class PaneTyped {
  /** One writer at a time in this process. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: Pick<FileSystem, "read" | "write" | "exists">,
    private readonly clock: Clock,
  ) {}

  /** The daemon typed this into the pane. */
  record(paneId: string, text: string, by: TypedBy): Promise<Result<void, MetatorError>> {
    const next = this.last.then(
      () => this.add(paneId, text, by),
      () => this.add(paneId, text, by),
    );
    this.last = next.catch(() => undefined);
    return next;
  }

  private async add(paneId: string, text: string, by: TypedBy): Promise<Result<void, MetatorError>> {
    const file = fileOf(paneId);
    const held = await readDocument(this.fs, file, PaneTypedDocument, "json");
    if (held.isErr()) return err(held.error);
    const now = this.clock.now();
    const fresh = (held.value?.lines ?? []).filter((l) => now.getTime() - Date.parse(l.at) < KEPT_MS);
    const lines = [...fresh, { hash: typedDigest(text), at: now.toISOString(), by }].slice(-KEPT_LINES);
    return writeDocument(this.fs, file, PaneTypedDocument, { lines }, "json");
  }

  /** Who typed these words into the pane lately; undefined: not the daemon (a person at its keyboard). */
  async by(paneId: string, text: string): Promise<TypedBy | undefined> {
    if (text.trim() === "") return undefined;
    const held = await readDocument(this.fs, fileOf(paneId), PaneTypedDocument, "json");
    if (held.isErr() || !held.value) return undefined;
    const hash = typedDigest(text);
    const now = this.clock.now().getTime();
    return held.value.lines.findLast((l) => l.hash === hash && now - Date.parse(l.at) < KEPT_MS)?.by;
  }
}
