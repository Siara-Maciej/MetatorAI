import { z } from "zod";
import { MetatorError } from "../domain/errors.ts";
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
  readonly files: readonly string[];
  readonly note?: string;
  readonly at: string;
}

export interface ScratchDropped {
  readonly dropped: readonly { readonly id: string; readonly files: readonly string[] }[];
  /** Patches that no longer apply: kept as they are, with why. */
  readonly failed: readonly {
    readonly id: string;
    readonly files: readonly string[];
    readonly why: string;
  }[];
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
      recorded = itemOf(record, record.files);
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
   * The records whose change is still in the working tree, each with the files that still hold
   * it, oldest first. A record nothing holds any more (taken out by hand) is removed.
   */
  async list(): Promise<Result<readonly ScratchItem[], MetatorError>> {
    const out: ScratchItem[] = [];
    for (const id of await this.ids()) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const inTree = await this.d.patches.holding(record.value.patch, "tree");
      if (inTree.isErr()) return err(inTree.error);
      if (inTree.value.length > 0) {
        out.push(itemOf(record.value, inTree.value));
        continue;
      }
      const staged = await this.d.patches.holding(record.value.patch, "index");
      if (staged.isErr()) return err(staged.error);
      if (staged.value.length > 0) {
        out.push(itemOf(record.value, staged.value));
        continue;
      }
      const gone = await this.d.fs.remove(fileOf(id));
      if (gone.isErr()) return err(gone.error);
    }
    return ok(out);
  }

  /** Takes the records' changes out again, the newest first: all of them, or the ones named. */
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
    for (const id of chosen) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      const reverted = await this.d.patches.revert(record.value.patch);
      if (reverted.isErr()) {
        failed.push({ id, files: record.value.files, why: reverted.error.message });
        continue;
      }
      const gone = await this.d.fs.remove(fileOf(id));
      if (gone.isErr()) return err(gone.error);
      dropped.push({ id, files: record.value.files });
    }
    return ok({ dropped, failed });
  }

  /**
   * The debug files a commit would hold (the commit guard, ADR-0094): the staged part of each
   * record, and with `commit -a` what of it is in the working tree of a file git tracks (a new
   * file nobody added is in no commit).
   */
  async inCommit(all: boolean): Promise<Result<readonly string[], MetatorError>> {
    const files = new Set<string>();
    for (const id of await this.ids()) {
      const record = await loadDocument(this.d.fs, fileOf(id), ScratchRecordDocument, "json");
      if (record.isErr()) return err(record.error);
      for (const where of all ? (["index", "tracked"] as const) : (["index"] as const)) {
        const held = await this.d.patches.holding(record.value.patch, where);
        if (held.isErr()) return err(held.error);
        for (const f of held.value) files.add(f);
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

function itemOf(record: ScratchRecord, files: readonly string[]): ScratchItem {
  return {
    id: record.id,
    files: [...files],
    ...(record.note ? { note: record.note } : {}),
    at: record.at,
  };
}
