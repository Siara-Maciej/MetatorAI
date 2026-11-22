import { z } from "zod";
import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import type { CommitReach } from "../domain/guard-commands.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { defineDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem, WorkingPatches } from "../ports/index.ts";
import { loadDocument, readDocument, writeDocument } from "./document-io.ts";

/** Where scratch records live: MetatorAI's local state, never committed. */
export const SCRATCH_DIR = ".metator/scratch";

/**
 * One direct edit not meant for a commit (`.metator/scratch/<id>.json`, ADR-0093): debug output,
 * a temporary switch, an experiment. The patch is the edit itself, so it can be taken out again
 * and a commit that would hold it can be stopped.
 */
const ScratchRecordSchema = z.strictObject({
  id: z.string().regex(/^s\d{3,}$/),
  at: z.iso.datetime(),
  /** What the edit is for, in the words of whoever made it. */
  note: z.string().optional(),
  files: z.array(z.string().min(1)).min(1),
  patch: z.string().min(1),
});
export type ScratchRecord = z.output<typeof ScratchRecordSchema>;
export const ScratchRecordDocument = defineDocument("ScratchRecord", {
  latest: ScratchRecordSchema,
  hint: "Written by `metator scratch end`; removed by `metator scratch drop`. Never edited by hand.",
});

/** The edit that is open now (`.metator/scratch/open.json`): the working tree as it was at `begin`. */
export const ScratchOpenDocument = defineDocument("ScratchOpen", {
  latest: z.strictObject({ snapshot: z.string().min(1), at: z.iso.datetime() }),
  hint: "Written by `metator scratch begin`, removed by `metator scratch end`.",
});

/** A record as a person sees it: without the patch. */
export interface ScratchItem {
  readonly id: string;
  /** The files that still hold its lines. */
  readonly files: readonly string[];
  readonly note?: string;
  readonly at: string;
  /**
   * `removable`: its change can be taken out as it was recorded. `changed`: a file still holds
   * its lines, but they (or the lines around them) changed since, so only a person takes them out.
   */
  readonly state: "removable" | "changed";
  /** For `changed`: which files, and what to do. */
  readonly why?: string;
}

/** A record that left by itself: no file holds its lines any more. */
export interface ScratchGone {
  readonly id: string;
  readonly files: readonly string[];
  /** `s002 is gone: src/tax.ts no longer holds it`. */
  readonly why: string;
}

export interface ScratchList {
  readonly items: readonly ScratchItem[];
  /** The records this look removed, each said once. */
  readonly gone: readonly ScratchGone[];
}

export interface ScratchDropped {
  readonly dropped: readonly { readonly id: string; readonly files: readonly string[] }[];
  /** Records whose lines changed since: kept as they are, with why. */
  readonly failed: readonly {
    readonly id: string;
    readonly files: readonly string[];
    readonly why: string;
  }[];
  /** Records no file held any more: removed, and said. */
  readonly gone: readonly ScratchGone[];
}

const OPEN = `${SCRATCH_DIR}/open.json`;
const fileOf = (id: string) => `${SCRATCH_DIR}/${id}.json`;

/**
 * Scratch (ADR-0093): `begin` and `end` around a direct edit record it as a patch; `list` shows
 * what is still in the working tree; `drop` takes it out again (a patch that no longer applies is
 * reported, never forced); `inCommit` tells the commit guard which debug files a commit would hold.
 */
export class Scratch {
  constructor(
    private readonly d: {
      readonly fs: Pick<FileSystem, "read" | "write" | "exists" | "glob" | "remove">;
      readonly clock: Clock;
      readonly patches: WorkingPatches;
    },
  ) {}

  async begin(): Promise<Result<{ readonly begun: string }, MetatorError>> {
    const open = await readDocument(this.d.fs, OPEN, ScratchOpenDocument, "json");
    if (open.isErr()) return err(open.error);
    if (open.value)
      return err(
        MetatorError.usage(
          `a scratch edit is already open (begun ${open.value.at}): end it first (\`metator scratch end\`)`,
        ),
      );
    const snapshot = await this.d.patches.snapshot();
    if (snapshot.isErr()) return err(snapshot.error);
    const at = this.d.clock.now().toISOString();
    const saved = await writeDocument(
      this.d.fs,
      OPEN,
      ScratchOpenDocument,
      { snapshot: snapshot.value, at },
      "json",
    );
    return saved.map(() => ({ begun: at }));
  }

  /** Closes the open edit: what changed since `begin` is one record; nothing changed, no record. */
  async end(input: {
    readonly note?: string;
  }): Promise<Result<{ readonly recorded: ScratchItem | null }, MetatorError>> {
    const open = await readDocument(this.d.fs, OPEN, ScratchOpenDocument, "json");
    if (open.isErr()) return err(open.error);
    if (!open.value)
      return err(MetatorError.usage("no scratch edit is open: begin one first (`metator scratch begin`)"));
    const now = await this.d.patches.snapshot();
    if (now.isErr()) return err(now.error);
    const change = await this.d.patches.between(open.value.snapshot, now.value);
    if (change.isErr()) return err(change.error);
    let recorded: ScratchItem | null = null;
    if (change.value.files.length > 0 && change.value.patch !== "") {
      const ids = await this.ids();
      const max = ids.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0);
      const note = input.note?.trim();
      const record: ScratchRecord = {
        id: `s${String(max + 1).padStart(3, "0")}`,
        at: this.d.clock.now().toISOString(),
        ...(note ? { note } : {}),
        files: [...change.value.files],
        patch: change.value.patch,
      };
      const saved = await writeDocument(this.d.fs, fileOf(record.id), ScratchRecordDocument, record, "json");
      if (saved.isErr()) return err(saved.error);
      recorded = { ...itemOf(record, record.files), state: "removable" };
    }
    const closed = await this.d.fs.remove(OPEN);
    if (closed.isErr()) return err(closed.error);
    return ok({ recorded });
  }

  /** How many records there are: from the files alone (cheap enough to ask on every state). */
  async count(): Promise<number> {
    return (await this.ids()).length;
  }

  /**
   * Where a record's lines are now: the files whose change can be taken out as recorded
   * (`exact`), and the files that hold its lines although they changed since (`changed`).
   */
  private async where(
    record: ScratchRecord,
  ): Promise<Result<{ exact: string[]; changed: string[] }, MetatorError>> {
    const exact = new Set<string>();
    const held = new Set<string>();
    for (const where of ["tree", "index"] as const) {
      const applies = await this.d.patches.holding(record.patch, where);
      if (applies.isErr()) return err(applies.error);
      for (const f of applies.value) exact.add(f);
      const remains = await this.d.patches.remains(record.patch, where);
      if (remains.isErr()) return err(remains.error);
      for (const f of remains.value) held.add(f);
    }
    return ok({ exact: [...exact].sort(), changed: [...held].filter((f) => !exact.has(f)).sort() });
  }

  /** A record no file holds any more leaves, and says so. */
  private async leave(record: ScratchRecord): Promise<Result<ScratchGone, MetatorError>> {
    const removed = await this.d.fs.remove(fileOf(record.id));
    if (removed.isErr()) return err(removed.error);
    const files = [...record.files].sort();
    return ok({
      id: record.id,
      files,
      why: `${record.id} is gone: ${files.join(", ")} no longer ${files.length === 1 ? "holds" : "hold"} it`,
    });
  }

  /**
   * Every record, oldest first, with the files that still hold its lines and whether it can
   * still be taken out as recorded. MetatorAI remembers a debug change until the person deals
   * with it: a record leaves here only when no file holds its lines any more, and that is said.
   */
  async list(): Promise<Result<ScratchList, MetatorError>> {
    const items: ScratchItem[] = [];
    const gone: ScratchGone[] = [];
    for (const id of await this.ids()) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const at = await this.where(record.value);
      if (at.isErr()) return err(at.error);
      const files = [...at.value.exact, ...at.value.changed].sort();
      if (files.length === 0) {
        const left = await this.leave(record.value);
        if (left.isErr()) return err(left.error);
        gone.push(left.value);
        continue;
      }
      items.push({
        ...itemOf(record.value, files),
        ...(at.value.changed.length > 0
          ? { state: "changed" as const, why: changedWhy(id, at.value.changed) }
          : { state: "removable" as const }),
      });
    }
    return ok({ items, gone });
  }

  /**
   * Takes the records' changes out again, the newest first: all of them, or the ones named. What
   * can be taken out as recorded is; a record with lines that changed since stays, with why.
   */
  async drop(input: {
    readonly ids?: readonly string[];
    readonly by: string;
  }): Promise<Result<ScratchDropped, MetatorError>> {
    if (input.by.trim() === "") return err(MetatorError.usage("say who removes them: --by <name>"));
    const all = await this.ids();
    const missing = (input.ids ?? []).find((id) => !all.includes(id));
    if (missing) return err(MetatorError.notFound(`scratch record ${missing}`));
    const chosen = (input.ids && input.ids.length > 0 ? all.filter((id) => input.ids?.includes(id)) : all)
      .slice()
      .reverse();
    const dropped: { id: string; files: readonly string[] }[] = [];
    const failed: { id: string; files: readonly string[]; why: string }[] = [];
    const gone: ScratchGone[] = [];
    for (const id of chosen) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const at = await this.where(record.value);
      if (at.isErr()) return err(at.error);
      if (at.value.exact.length === 0 && at.value.changed.length === 0) {
        const left = await this.leave(record.value);
        if (left.isErr()) return err(left.error);
        gone.push(left.value);
        continue;
      }
      let changed = at.value.changed;
      if (at.value.exact.length > 0) {
        const reverted = await this.d.patches.revert(record.value.patch, at.value.exact);
        // Git refused although the check passed a moment ago: these files stay with the record too.
        if (reverted.isErr()) changed = [...changed, ...at.value.exact].sort();
      }
      if (changed.length > 0) {
        failed.push({ id, files: changed, why: changedWhy(id, changed) });
        continue;
      }
      const removed = await this.d.fs.remove(fileOf(id));
      if (removed.isErr()) return err(removed.error);
      dropped.push({ id, files: at.value.exact });
    }
    return ok({ dropped, failed, gone });
  }

  /** The person dismisses records: they are forgotten, and the files stay as they are. */
  async forget(input: {
    readonly ids: readonly string[];
    readonly by: string;
  }): Promise<
    Result<{ readonly forgotten: readonly { id: string; files: readonly string[] }[] }, MetatorError>
  > {
    if (input.ids.length === 0)
      return err(MetatorError.usage("name the records to forget: --id <id> (repeatable)"));
    const all = await this.ids();
    const missing = input.ids.find((id) => !all.includes(id));
    if (missing) return err(MetatorError.notFound(`scratch record ${missing}`));
    if (input.by.trim() === "") return err(MetatorError.usage("say who forgets them: --by <name>"));
    const forgotten: { id: string; files: readonly string[] }[] = [];
    for (const id of all.filter((x) => input.ids.includes(x))) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const at = await this.where(record.value);
      if (at.isErr()) return err(at.error);
      const held = [...at.value.exact, ...at.value.changed].sort();
      const removed = await this.d.fs.remove(fileOf(id));
      if (removed.isErr()) return err(removed.error);
      forgotten.push({ id, files: held.length > 0 ? held : [...record.value.files].sort() });
    }
    return ok({ forgotten });
  }

  /**
   * The debug files a commit would hold (the commit guard, ADR-0094): what of each record is
   * staged, and what the commit's own command line takes from the working tree (`commitReach`:
   * `commit -a`, `git add <paths>` before it, paths named on it). A new file nobody added is in a
   * commit only when the line adds it. Lines that changed since count too: a commit is stopped
   * while a file still holds what was recorded. Asking removes nothing.
   */
  async inCommit(reach: CommitReach): Promise<Result<readonly string[], MetatorError>> {
    const files = new Set<string>();
    const named = (file: string) =>
      reach.paths.some(
        (p) => file === p || file.startsWith(`${p}/`) || (/[*?[]/.test(p) && matchesAny(file, [p])),
      );
    for (const id of await this.ids()) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const places = [
        ["index", () => true],
        ...(reach.tracked ? ([["tracked", () => true]] as const) : []),
        ...(reach.untracked ? ([["tree", () => true]] as const) : []),
        ...(reach.paths.length > 0 ? ([["tree", named]] as const) : []),
      ] as const;
      for (const [where, counts] of places) {
        const held = await this.d.patches.holding(record.value.patch, where);
        if (held.isErr()) return err(held.error);
        const remains = await this.d.patches.remains(record.value.patch, where);
        if (remains.isErr()) return err(remains.error);
        for (const f of [...held.value, ...remains.value]) if (counts(f)) files.add(f);
      }
    }
    return ok([...files].sort());
  }

  /** The ids of the records there are, oldest first. */
  private async ids(): Promise<string[]> {
    return (await this.d.fs.glob([`${SCRATCH_DIR}/s*.json`]))
      .map((f) => (f.split("/").at(-1) as string).replace(/\.json$/, ""))
      .filter((id) => /^s\d{3,}$/.test(id))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }
}

function itemOf(record: ScratchRecord, files: readonly string[]): Omit<ScratchItem, "state"> {
  return {
    id: record.id,
    files: [...files],
    ...(record.note ? { note: record.note } : {}),
    at: record.at,
  };
}

/** What a person is told of a record whose lines changed since it was recorded. */
function changedWhy(id: string, files: readonly string[]): string {
  return `${files.join(", ")} changed since it was recorded: its debug lines can no longer be taken out as they were. Take them out by hand, or forget the record (\`metator scratch forget --id ${id}\`)`;
}
