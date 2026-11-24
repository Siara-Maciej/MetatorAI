/**
 * The one way a plan is edited in the app (the run's plan, a system plan, the system map): read it,
 * "Edit" (fields) or "Edit as text" (JSON the daemon checks), "Check" asks for the lint without
 * saving, "Save…" first says what changes, then asks who and writes with the digest it was read
 * at. A write on an old version shows what is there now: Reload, or keep my edits and save over it.
 */

import { useEffect, useRef, useState } from "react";
import type { Envelope, PlanLintProblem, PlanLintView } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { lintSummary, refusalText } from "../../shared/model/format.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { conflictCurrent, documentText, parseDocumentText, refusedProblems } from "./plan-edit.ts";

export type EditMode = "view" | "form" | "text";

export interface DocSource<V, D> {
  /** The view as the daemon answered it last; none while it is read. */
  readonly view: V | undefined;
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

export interface DocEditor<V, D> {
  readonly mode: EditMode;
  readonly draft: D | undefined;
  readonly text: string;
  /** Problems to show now: the last check's (or a refused save's), else the view's lint. */
  readonly problems: readonly PlanLintProblem[];
  /** True while the problems are the last check's, not the saved plan's. */
  readonly checked: boolean;
  /** The summary shown before a save; set by `review()`. */
  readonly pending: readonly string[] | undefined;
  /** The view as it is now on the daemon, when a save was based on an older one. */
  readonly conflict: V | undefined;
  readonly busy: boolean;
  readonly dirty: boolean;
  edit(mode: "form" | "text"): void;
  cancel(): void;
  setDraft(change: (d: D) => D): void;
  setText(text: string): void;
  check(): Promise<void>;
  review(): void;
  save(): Promise<void>;
  /** After a conflict: drop my edits and read the document again. */
  reloadTheirs(): Promise<void>;
  /** After a conflict: keep my edits, now based on the version that is there. */
  keepMine(): void;
  readonly notice: { text: string | undefined; tone: "error" | "info"; onClose(): void };
}

/**
 * `startEditing`: open in the edit mode once the document is read and may be changed ("Fix the
 * plan" from an approval card lands here).
 */
export function useDocEditor<V, D>(source: DocSource<V, D>, startEditing = false): DocEditor<V, D> {
  const { who } = useDaemon("who");
  const [mode, setMode] = useState<EditMode>("view");
  const [draft, setDraftState] = useState<D>();
  const [base, setBase] = useState<{ doc: D | null; digest: string | null }>();
  const [text, setTextState] = useState("");
  const [checked, setChecked] = useState<PlanLintProblem[]>();
  const [pending, setPending] = useState<string[]>();
  const [conflict, setConflict] = useState<V>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "error" | "info" }>();
  const view = source.view;
  /** The draft as a document: the fields, or the text parsed (or why it does not parse). */
  const current = ():
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly problem: PlanLintProblem } =>
    mode === "text" ? parseDocumentText(text) : { ok: true, value: draft };
  const edit = (to: "form" | "text") => {
    if (!view) return;
    if (mode === "view") {
      const doc = source.docOf(view) ?? source.blank?.() ?? null;
      if (doc === null) return;
      setBase({ doc: source.docOf(view), digest: source.digestOf(view) });
      setDraftState(doc);
      setTextState(documentText(doc));
    } else if (to === "text" && mode === "form") setTextState(documentText(draft));
    else if (to === "form" && mode === "text") {
      const parsed = parseDocumentText(text);
      if (!parsed.ok) {
        setChecked([parsed.problem]);
        return;
      }
      setDraftState(parsed.value as D);
    }
    setChecked(undefined);
    setPending(undefined);
    setMode(to);
  };
  const reset = () => {
    setMode("view");
    setDraftState(undefined);
    setBase(undefined);
    setChecked(undefined);
    setPending(undefined);
    setConflict(undefined);
  };
  const started = useRef(false);
  useEffect(() => {
    if (!startEditing) {
      started.current = false;
      return;
    }
    if (started.current || !view || mode !== "view" || !source.editable(view)) return;
    started.current = true;
    edit("form");
  });
  const check = async () => {
    const doc = current();
    if (!doc.ok) {
      setChecked([doc.problem]);
      return;
    }
    if (!source.check) {
      setChecked([]);
      return;
    }
    setBusy(true);
    const r = await source.check(doc.value);
    setBusy(false);
    if (r.ok && r.data) setChecked([...r.data.problems]);
    else setNote({ text: refusalText(r.error, "the check did not answer"), tone: "error" });
  };
  const review = () => {
    const doc = current();
    if (!doc.ok) {
      setChecked([doc.problem]);
      return;
    }
    const before = base?.doc;
    const lines = before ? source.changes(before, doc.value as D) : ["a new document"];
    setPending(lines.length > 0 ? lines : ["nothing changed"]);
  };
  const save = async () => {
    const doc = current();
    if (!doc.ok) {
      setChecked([doc.problem]);
      return;
    }
    const by = await who();
    if (!by) return;
    setBusy(true);
    const r = await source.save(doc.value, base?.digest ?? null, by);
    setBusy(false);
    if (r.ok) {
      reset();
      setNote({ text: `Saved by ${by}.`, tone: "info" });
      await source.reload();
      return;
    }
    setPending(undefined);
    const theirs = conflictCurrent<V>(r.error);
    if (theirs) {
      setConflict(theirs);
      return;
    }
    const problems = refusedProblems(r.error?.details);
    if (problems.length > 0) setChecked(problems);
    setNote({ text: refusalText(r.error, "the plan was not saved"), tone: "error" });
  };
  const problems = checked ?? (view ? source.lintOf(view).problems : []);
  const dirty =
    mode === "text"
      ? text !== documentText(base?.doc ?? null)
      : JSON.stringify(draft) !== JSON.stringify(base?.doc ?? null);
  return {
    mode,
    draft,
    text,
    problems,
    checked: checked !== undefined,
    pending,
    conflict,
    busy,
    dirty: mode !== "view" && dirty,
    edit,
    cancel: reset,
    setDraft: (change) => {
      setDraftState((d) => (d === undefined ? d : change(d)));
      setPending(undefined);
    },
    setText: (t) => {
      setTextState(t);
      setPending(undefined);
    },
    check,
    review,
    save,
    reloadTheirs: async () => {
      reset();
      await source.reload();
    },
    keepMine: () => {
      if (conflict) setBase({ doc: source.docOf(conflict), digest: source.digestOf(conflict) });
      setConflict(undefined);
    },
    notice: { text: note?.text, tone: note?.tone ?? "error", onClose: () => setNote(undefined) },
  };
}

/**
 * The bar of a document: in view mode its lint and the ways to edit it (or why it cannot be
 * edited); while editing, Check, Cancel and Save…, the summary before a save, a conflict's choice.
 */
export function EditBar<V, D>({
  editor,
  source,
  noun,
  testId,
  children,
}: {
  readonly editor: DocEditor<V, D>;
  readonly source: DocSource<V, D>;
  /** What is edited: `plan`, `system plan`, `system map`. */
  readonly noun: string;
  readonly testId?: string;
  /** More buttons of view mode (Approve). */
  readonly children?: React.ReactNode;
}) {
  const view = source.view;
  const lint = { problems: editor.problems };
  const errors = editor.problems.filter((p) => p.severity === "error").length;
  return (
    <div className="edit-bar" data-testid={testId}>
      <div className="line">
        <span className={errors > 0 ? "red" : editor.problems.length > 0 ? "amber" : "green"}>
          {editor.checked ? "check" : "lint"}: {lintSummary(lint)}
        </span>
        {editor.mode === "view" ? (
          view && source.editable(view) ? (
            <>
              <span className="spacer" />
              {children}
              <Button onClick={() => editor.edit("form")}>Edit {noun}</Button>
              <Button onClick={() => editor.edit("text")}>Edit as text</Button>
            </>
          ) : (
            <>
              <span className="faint read-only">
                Read-only{view && source.readOnlyBecause(view) ? `: ${source.readOnlyBecause(view)}` : ""}
              </span>
              <span className="spacer" />
              {children}
            </>
          )
        ) : (
          <>
            <span className="faint">
              Editing the {noun}
              {editor.mode === "text" ? " as text" : ""}
              {editor.dirty ? " · changed" : ""}
            </span>
            <span className="spacer" />
            {editor.mode === "form" ? (
              <Button variant="ghost" onClick={() => editor.edit("text")}>
                As text
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => editor.edit("form")}>
                As fields
              </Button>
            )}
            <Button disabled={editor.busy} onClick={() => void editor.check()}>
              Check
            </Button>
            <Button onClick={editor.cancel}>Cancel</Button>
            <Button variant="primary" disabled={editor.busy} onClick={editor.review}>
              Save…
            </Button>
          </>
        )}
      </div>
      {editor.pending ? (
        <section className="save-review" aria-label="what the save changes">
          <strong>Save these changes?</strong>
          <ul>
            {editor.pending.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {errors > 0 ? (
            <div className="amber">
              The {noun} has {errors === 1 ? "an error" : `${errors} errors`}: it is saved anyway, and the
              lint stays on it.
            </div>
          ) : null}
          <div className="actions">
            <Button variant="primary" disabled={editor.busy} onClick={() => void editor.save()}>
              Save
            </Button>
            <Button onClick={() => editor.review()}>Show again</Button>
          </div>
        </section>
      ) : null}
      {editor.conflict ? (
        <div className="conflict" role="alert" data-testid="edit-conflict">
          <strong>The {noun} changed since you opened it.</strong>{" "}
          <span className="muted">
            Someone (or the run) saved it while you were editing. Reload it and make your change again, or
            keep your edits and save them over the new version.
          </span>
          <div className="actions">
            <Button variant="primary" onClick={() => void editor.reloadTheirs()}>
              Reload
            </Button>
            <Button onClick={editor.keepMine}>Keep my edits</Button>
          </div>
        </div>
      ) : null}
      <Notice {...editor.notice} />
    </div>
  );
}

/** The problems of a draft that belong to no step or field shown: the plan's own, and the text's. */
export function ProblemList({
  problems,
  testId,
}: {
  readonly problems: readonly PlanLintProblem[];
  readonly testId?: string;
}) {
  if (problems.length === 0) return null;
  return (
    <ul className="problems" data-testid={testId}>
      {problems.map((p, i) => (
        <li
          key={`${p.code ?? ""}-${p.message}-${String(i)}`}
          className={p.severity === "error" ? "red" : "amber"}
        >
          {p.severity}
          {p.step ? ` · ${p.step}` : ""}
          {p.field ? ` · ${p.field}` : ""}: {p.message}
        </li>
      ))}
    </ul>
  );
}

/** The problems of one field, under it. */
export const FieldProblems = ({ problems }: { readonly problems: readonly PlanLintProblem[] }) =>
  problems.length === 0 ? null : (
    <span className="field-problems">
      {problems.map((p, i) => (
        <span key={`${p.message}-${String(i)}`} className={p.severity === "error" ? "red" : "amber"}>
          {p.message}
        </span>
      ))}
    </span>
  );
