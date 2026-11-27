/**
 * The one way a plan is edited in the app (the run's plan, a system plan, the system map): read it,
 * "Edit" (fields) or "Edit as text" (JSON the daemon checks), "Check" asks for the lint without
 * saving, "Save…" first says what changes, then asks who and writes with the digest it was read
 * at. A write on an old version shows what is there now: Reload, or keep my edits and save over it.
 *
 * What the editor keeps is the DocEdit store (`doc-editor-state.ts`, ADR-0113), made by
 * `<DocEditorScope>`; each part of the bar reads only the value it draws.
 */

import type { ReactNode } from "react";
import type { PlanLintProblem } from "../../shared/api/api.ts";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { lintSummary } from "../../shared/model/format.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { DocEdit, type DocSource, dirtyOf, useDocEdit } from "./doc-editor-state.ts";

const NO_PROBLEMS: readonly PlanLintProblem[] = [];

/** The editor of one document: its store lives as long as this scope. */
export function DocEditorScope<V, D>({
  source,
  children,
}: {
  readonly source: DocSource<V, D>;
  readonly children?: ReactNode;
}) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider
      store={DocEdit}
      init={{ source: source as unknown as DocSource<unknown, unknown>, daemon }}
    >
      {children}
    </ScopeProvider>
  );
}

/** Problems to show now: the last check's (or a refused save's), else the view's lint. */
export function useProblems<V, D>(view: V | undefined, source: DocSource<V, D>): readonly PlanLintProblem[] {
  const checked = useDocEdit((s) => s.checked);
  return checked ?? (view ? source.lintOf(view).problems : NO_PROBLEMS);
}

interface BarProps<V, D> {
  /** The view as the daemon answered it last; none while it is read. */
  readonly view: V | undefined;
  readonly source: DocSource<V, D>;
  /** What is edited: `plan`, `system plan`, `system map`. */
  readonly noun: string;
}

/**
 * The bar of a document: in view mode its lint and the ways to edit it (or why it cannot be
 * edited); while editing, Check, Cancel and Save…, the summary before a save, a conflict's choice.
 */
export function EditBar<V, D>({
  view,
  source,
  noun,
  testId,
  children,
}: BarProps<V, D> & {
  readonly testId?: string;
  /** More buttons of view mode (Approve). */
  readonly children?: ReactNode;
}) {
  const viewing = useDocEdit((s) => s.mode === "view");
  return (
    <div className="edit-bar" data-testid={testId}>
      <div className="line">
        <LintLine view={view} source={source} />
        {viewing ? (
          view && source.editable(view) ? (
            <>
              <span className="spacer" />
              {children}
              <EditButton view={view} to="form">
                Edit {noun}
              </EditButton>
              <EditButton view={view} to="text">
                Edit as text
              </EditButton>
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
          <Editing noun={noun} view={view} />
        )}
      </div>
      <SaveReview view={view} source={source} noun={noun} />
      <Conflict noun={noun} />
      <EditNotice />
    </div>
  );
}

function LintLine<V, D>({ view, source }: Omit<BarProps<V, D>, "noun">) {
  const problems = useProblems(view, source);
  const checked = useDocEdit((s) => s.checked !== undefined);
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <span className={errors > 0 ? "red" : problems.length > 0 ? "amber" : "green"}>
      {checked ? "check" : "lint"}: {lintSummary({ problems })}
    </span>
  );
}

function EditButton({
  view,
  to,
  ghost = false,
  children,
}: {
  readonly view: unknown;
  readonly to: "form" | "text";
  readonly ghost?: boolean;
  readonly children: ReactNode;
}) {
  const edit = useDocEdit((s) => s.edit);
  return (
    <Button variant={ghost ? "ghost" : "default"} onClick={() => edit(to, view)}>
      {children}
    </Button>
  );
}

/** While editing: what is edited and whether it changed, the other mode, Check, Cancel and Save…. */
function Editing({ noun, view }: { readonly noun: string; readonly view: unknown }) {
  const mode = useDocEdit((s) => s.mode);
  const dirty = useDocEdit(dirtyOf);
  const busy = useDocEdit((s) => s.busy);
  const check = useDocEdit((s) => s.check);
  const cancel = useDocEdit((s) => s.cancel);
  const review = useDocEdit((s) => s.review);
  return (
    <>
      <span className="faint">
        Editing the {noun}
        {mode === "text" ? " as text" : ""}
        {dirty ? " · changed" : ""}
      </span>
      <span className="spacer" />
      {mode === "form" ? (
        <EditButton view={view} to="text" ghost>
          As text
        </EditButton>
      ) : (
        <EditButton view={view} to="form" ghost>
          As fields
        </EditButton>
      )}
      <Button disabled={busy} onClick={() => void check()}>
        Check
      </Button>
      <Button onClick={cancel}>Cancel</Button>
      <Button variant="primary" disabled={busy} onClick={review}>
        Save…
      </Button>
    </>
  );
}

/** The summary before a save, with what the lint says against it. */
function SaveReview<V, D>({ view, source, noun }: BarProps<V, D>) {
  const pending = useDocEdit((s) => s.pending);
  const busy = useDocEdit((s) => s.busy);
  const save = useDocEdit((s) => s.save);
  const review = useDocEdit((s) => s.review);
  const errors = useProblems(view, source).filter((p) => p.severity === "error").length;
  return pending ? (
    <section className="save-review" aria-label="what the save changes">
      <strong>Save these changes?</strong>
      <ul>
        {pending.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {errors > 0 ? (
        <div className="amber">
          The {noun} has {errors === 1 ? "an error" : `${errors} errors`}: it is saved anyway, and the lint
          stays on it.
        </div>
      ) : null}
      <div className="actions">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button onClick={() => review()}>Show again</Button>
      </div>
    </section>
  ) : null;
}

function Conflict({ noun }: { readonly noun: string }) {
  const conflict = useDocEdit((s) => s.conflict !== undefined);
  const reloadTheirs = useDocEdit((s) => s.reloadTheirs);
  const keepMine = useDocEdit((s) => s.keepMine);
  return conflict ? (
    <div className="conflict" role="alert" data-testid="edit-conflict">
      <strong>The {noun} changed since you opened it.</strong>{" "}
      <span className="muted">
        Someone (or the run) saved it while you were editing. Reload it and make your change again, or keep
        your edits and save them over the new version.
      </span>
      <div className="actions">
        <Button variant="primary" onClick={() => void reloadTheirs()}>
          Reload
        </Button>
        <Button onClick={keepMine}>Keep my edits</Button>
      </div>
    </div>
  ) : null;
}

function EditNotice() {
  const notice = useDocEdit((s) => s.notice);
  const closeNotice = useDocEdit((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
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
