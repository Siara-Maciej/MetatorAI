/**
 * What the document editor keeps while a document is open (ADR-0113): the edit mode, the draft (as
 * fields or as text), what it was read at, the last check, the summary before a save, a conflict,
 * and what the last check or save answered. A store per editor: each field of a form reads its
 * own part of the draft, so typing in one draws that field again, not the form.
 */
import type { Envelope, PlanLintProblem, PlanLintView } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { refusalText } from "../../shared/model/format.ts";
import { type ActionState, IDLE, sayIn } from "../../shared/state/action.ts";
import { scopedStore, useScoped } from "../../shared/state/scoped-store.ts";
import { conflictCurrent, documentText, parseDocumentText, refusedProblems } from "./plan-edit.ts";

type EditMode = "view" | "form" | "text";

/**
 * How one kind of document is read, checked and written. The view (`V`) is what the daemon
 * answered; the document (`D`) is what a person edits. Every request reads the daemon at the
 * moment it is made.
 */
export interface DocSource<V, D> {
  /** Reads the document again now (after a save, or to drop my edits). */
  reload(): Promise<unknown>;
  docOf(view: V): D | null;
  digestOf(view: V): string | null;
  lintOf(view: V): PlanLintView;
  editable(view: V): boolean;
  readOnlyBecause(view: V): string | undefined;
  /** The lint of a draft, without saving; none when the daemon has no check for this document. */
  check?: ((doc: unknown) => Promise<Envelope<PlanLintView>>) | undefined;
  save(doc: unknown, digest: string | null, by: string): Promise<Envelope<V>>;
  /** What a save changes, in words. */
  changes(before: D, after: D): string[];
  /** The document a person starts from when there is none yet. */
  blank?: (() => D) | undefined;
}

export interface DocEditState extends ActionState {
  readonly mode: EditMode;
  readonly draft: unknown;
  /** The document and its digest as they were read when the editing started (or kept over a conflict). */
  readonly base: { readonly doc: unknown; readonly digest: string | null } | undefined;
  readonly text: string;
  /** The last check's problems (or a refused save's); undefined: the view's lint shows. */
  readonly checked: readonly PlanLintProblem[] | undefined;
  /** The summary shown before a save; set by `review()`. */
  readonly pending: readonly string[] | undefined;
  /** The view as it is now on the daemon, when a save was based on an older one. */
  readonly conflict: unknown;

  /** Starts editing `view` (or switches between fields and text). */
  edit(to: "form" | "text", view: unknown): void;
  cancel(): void;
  setDraft<D>(change: (d: D) => D): void;
  setText(text: string): void;
  check(): Promise<void>;
  review(): void;
  save(): Promise<void>;
  /** After a conflict: drop my edits and read the document again. */
  reloadTheirs(): Promise<void>;
  /** After a conflict: keep my edits, now based on the version that is there. */
  keepMine(): void;
  closeNotice(): void;
}

export interface DocEditInit {
  readonly source: DocSource<unknown, unknown>;
  readonly daemon: Store<Pick<Daemon, "who">>;
}

const CLOSED = {
  mode: "view",
  draft: undefined,
  base: undefined,
  checked: undefined,
  pending: undefined,
  conflict: undefined,
} as const;

export const DocEdit = scopedStore<DocEditState, DocEditInit>(
  "DocEdit",
  ({ source, daemon }) =>
    (set, get, api) => {
      /** The draft as a document: the fields, or the text parsed (or why it does not parse). */
      const current = ():
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly problem: PlanLintProblem } => {
        const { mode, text, draft } = get();
        return mode === "text" ? parseDocumentText(text) : { ok: true, value: draft };
      };
      return {
        ...IDLE,
        ...CLOSED,
        text: "",

        edit: (to, view) => {
          const { mode, draft, text } = get();
          if (!view) return;
          if (mode === "view") {
            const doc = source.docOf(view) ?? source.blank?.() ?? null;
            if (doc === null) return;
            set({
              base: { doc: source.docOf(view), digest: source.digestOf(view) },
              draft: doc,
              text: documentText(doc),
            });
          } else if (to === "text" && mode === "form") set({ text: documentText(draft) });
          else if (to === "form" && mode === "text") {
            const parsed = parseDocumentText(text);
            if (!parsed.ok) {
              set({ checked: [parsed.problem] });
              return;
            }
            set({ draft: parsed.value });
          }
          set({ checked: undefined, pending: undefined, mode: to });
        },
        cancel: () => set(CLOSED),
        setDraft: (change) =>
          set((s) => ({
            draft: s.draft === undefined ? s.draft : change(s.draft as Parameters<typeof change>[0]),
            pending: undefined,
          })),
        setText: (text) => set({ text, pending: undefined }),
        check: async () => {
          const doc = current();
          if (!doc.ok) {
            set({ checked: [doc.problem] });
            return;
          }
          if (!source.check) {
            set({ checked: [] });
            return;
          }
          set({ busy: true });
          const r = await source.check(doc.value);
          set({ busy: false });
          if (r.ok && r.data) set({ checked: [...r.data.problems] });
          else sayIn(api, refusalText(r.error, "the check did not answer"));
        },
        review: () => {
          const doc = current();
          if (!doc.ok) {
            set({ checked: [doc.problem] });
            return;
          }
          const before = get().base?.doc;
          const lines = before ? source.changes(before, doc.value) : ["a new document"];
          set({ pending: lines.length > 0 ? lines : ["nothing changed"] });
        },
        save: async () => {
          const doc = current();
          if (!doc.ok) {
            set({ checked: [doc.problem] });
            return;
          }
          const by = await daemon.getState().who();
          if (!by) return;
          set({ busy: true });
          const r = await source.save(doc.value, get().base?.digest ?? null, by);
          set({ busy: false });
          if (r.ok) {
            set(CLOSED);
            sayIn(api, `Saved by ${by}.`, "info");
            await source.reload();
            return;
          }
          set({ pending: undefined });
          const theirs = conflictCurrent<unknown>(r.error);
          if (theirs) {
            set({ conflict: theirs });
            return;
          }
          const problems = refusedProblems(r.error?.details);
          if (problems.length > 0) set({ checked: problems });
          sayIn(api, refusalText(r.error, "the plan was not saved"));
        },
        reloadTheirs: async () => {
          set(CLOSED);
          await source.reload();
        },
        keepMine: () => {
          const { conflict } = get();
          if (conflict) set({ base: { doc: source.docOf(conflict), digest: source.digestOf(conflict) } });
          set({ conflict: undefined });
        },
        closeNotice: () => set({ notice: undefined }),
      };
    },
);

/** Whether the draft differs from what was read: the text as typed, or the fields. */
export const dirtyOf = (s: Pick<DocEditState, "mode" | "text" | "draft" | "base">): boolean =>
  s.mode !== "view" &&
  (s.mode === "text"
    ? s.text !== documentText(s.base?.doc ?? null)
    : JSON.stringify(s.draft) !== JSON.stringify(s.base?.doc ?? null));

/** One value of the editor's state: the part draws again only when it changed. */
export const useDocEdit = <T>(select: (s: DocEditState) => T): T => useScoped(DocEdit, select);
