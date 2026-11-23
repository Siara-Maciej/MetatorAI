import { z } from "zod";
import type { MetatorError } from "../domain/errors.ts";
import { err, type Result } from "../domain/result.ts";
import { defineDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";
import { typedDigest } from "./pane-typed.ts";

/** What the guard answered about a command it did not simply allow. */
export type GuardAskedDecision = "ask" | "deny";

/**
 * Why the guard asked about (or refused) a pane's commands lately (`.metator/guard-asked/<pane>.json`):
 * the command's hash (its spacing left out), never the command, with the guard's own reason. A host does not always show
 * a hook's reason in its prompt (Claude Code does not); the daemon reads it from here and puts it
 * on the card that prompt becomes.
 */
export const GuardAskedDocument = defineDocument("GuardAsked", {
  latest: z.strictObject({
    asked: z.array(
      z.strictObject({
        hash: z.string().min(1),
        at: z.iso.datetime(),
        decision: z.enum(["ask", "deny"]),
        reason: z.string().min(1),
      }),
    ),
  }),
  hint: "Written by `metator guard pre-tool` when it asks or refuses; never by hand or by an agent.",
});

/** How long a reason is kept (a prompt is answered within minutes), and how many per pane. */
const KEPT_MS = 10 * 60_000;
const KEPT = 20;

/**
 * A command's hash, whatever its spacing: the hook gets the command as it runs, the daemon reads it
 * from the host's screen, where a line break may be a space, a wrapped row or nothing at all.
 */
const commandHash = (command: string): string => typedDigest(command.replace(/\s+/g, ""));

const fileOf = (paneId: string): string =>
  `.metator/guard-asked/${paneId.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`;

export class GuardAsked {
  /** One writer at a time in this process. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: Pick<FileSystem, "read" | "write" | "exists">,
    private readonly clock: Clock,
  ) {}

  /** The guard asked about (or refused) this command in this pane, for this reason. */
  record(
    paneId: string,
    command: string,
    decision: GuardAskedDecision,
    reason: string,
  ): Promise<Result<void, MetatorError>> {
    const add = () => this.add(paneId, command, decision, reason);
    const next = this.last.then(add, add);
    this.last = next.catch(() => undefined);
    return next;
  }

  private async add(
    paneId: string,
    command: string,
    decision: GuardAskedDecision,
    reason: string,
  ): Promise<Result<void, MetatorError>> {
    const file = fileOf(paneId);
    const held = await readDocument(this.fs, file, GuardAskedDocument, "json");
    if (held.isErr()) return err(held.error);
    const now = this.clock.now();
    const fresh = (held.value?.asked ?? []).filter((a) => now.getTime() - Date.parse(a.at) < KEPT_MS);
    const asked = [...fresh, { hash: commandHash(command), at: now.toISOString(), decision, reason }].slice(
      -KEPT,
    );
    return writeDocument(this.fs, file, GuardAskedDocument, { asked }, "json");
  }

  /** The guard's last word about this command in this pane, while it is fresh. */
  async reasonFor(
    paneId: string,
    command: string,
  ): Promise<{ readonly decision: GuardAskedDecision; readonly reason: string } | undefined> {
    if (command.trim() === "") return undefined;
    const held = await readDocument(this.fs, fileOf(paneId), GuardAskedDocument, "json");
    if (held.isErr() || !held.value) return undefined;
    const hash = commandHash(command);
    const now = this.clock.now().getTime();
    const found = held.value.asked.findLast((a) => a.hash === hash && now - Date.parse(a.at) < KEPT_MS);
    return found ? { decision: found.decision, reason: found.reason } : undefined;
  }
}
