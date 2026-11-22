import { z } from "zod";
import type { MetatorError } from "../domain/errors.ts";
import { CONSENTS_DIR } from "../domain/hook.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { defineDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";

/**
 * The consents a person gave in words in one session (`.metator/consents/<session>.json`,
 * ADR-0094): each for one kind of guarded command (`commit`, `push`), valid for a few minutes,
 * used once. Only the user-prompt guard writes them; the pre-tool guard uses them up.
 */
export const GuardConsentsDocument = defineDocument("GuardConsents", {
  latest: z.strictObject({
    consents: z.array(
      z.strictObject({
        kind: z.string().min(1),
        /** The person's message, cut: what they said that counts as the consent. */
        words: z.string(),
        at: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      }),
    ),
  }),
  hint: "Written by `metator guard user-prompt` from the person's own words; never by hand or by an agent.",
});

/** Where a session's consents are kept: its pane id, else the host's session id. */
const fileOf = (session: string): string =>
  `${CONSENTS_DIR}/${session.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;

export class GuardConsents {
  constructor(
    private readonly fs: Pick<FileSystem, "read" | "write" | "exists">,
    private readonly clock: Clock,
  ) {}

  /** The consents of a session that still hold now. */
  private async load(
    session: string,
  ): Promise<Result<{ kind: string; words: string; at: string; expiresAt: string }[], MetatorError>> {
    const file = fileOf(session);
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const doc = parseDocumentText(text.value, file, GuardConsentsDocument, "json");
    if (doc.isErr()) return err(doc.error);
    const now = this.clock.now().toISOString();
    return ok(doc.value.consents.filter((c) => c.expiresAt > now));
  }

  private save(
    session: string,
    consents: { kind: string; words: string; at: string; expiresAt: string }[],
  ): Promise<Result<void, MetatorError>> {
    return this.fs.write(fileOf(session), serializeJsonDocument(GuardConsentsDocument.stamp({ consents })));
  }

  /** The person consented to these kinds, in these words: each holds for `minutes`, for one command. */
  async grant(
    session: string,
    kinds: readonly string[],
    words: string,
    minutes: number,
  ): Promise<Result<void, MetatorError>> {
    const held = await this.load(session);
    if (held.isErr()) return err(held.error);
    const now = this.clock.now();
    const fresh = kinds.map((kind) => ({
      kind,
      words: words.slice(0, 200),
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    }));
    // A new consent to a kind replaces the one still held: one use per kind.
    return this.save(session, [...held.value.filter((c) => !kinds.includes(c.kind)), ...fresh]);
  }

  /** The kinds a session may still use. */
  async valid(session: string): Promise<Result<readonly string[], MetatorError>> {
    return (await this.load(session)).map((consents) => consents.map((c) => c.kind));
  }

  /** These consents were used for a command: they are gone. */
  async use(session: string, kinds: readonly string[]): Promise<Result<void, MetatorError>> {
    const held = await this.load(session);
    if (held.isErr()) return err(held.error);
    return this.save(
      session,
      held.value.filter((c) => !kinds.includes(c.kind)),
    );
  }
}
