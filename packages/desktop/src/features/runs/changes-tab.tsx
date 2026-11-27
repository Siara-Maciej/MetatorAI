/**
 * The change of a run with your notes on it (S5, design/13 §5): the files on the left with their
 * line counts, one file's diff on the right; a click on a line opens a note there; the notes go
 * to the run's agents as one message with "Send to agent". Nothing here edits the code.
 *
 * The tab only lays its parts out (ADR-0113): what it keeps is the Changes store
 * (`changes-state.ts`); a file row reads only whether it is the one shown, a diff line only
 * whether a note is written on it, so choosing a file or a line draws those again, not the tab.
 */

import { useEffect } from "react";
import type { DiffLine, FileDiff, ReviewNote, RunChangesView } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon, useDaemonStore, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { lookOf } from "../../shared/model/look.ts";
import type { Run } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { Changes, notesKey, reviewKey, useChanges, useChangesApi } from "./changes-state.ts";
import { useRunControls } from "./run-controls.ts";
import { storeAction } from "./store-action.ts";

type OpenFile = (runId: string, file?: string) => void;

export function ChangesTab({
  run,
  runId,
  file,
  onOpenFile,
}: {
  readonly run: Run | undefined;
  readonly runId: string;
  readonly file?: string | undefined;
  onOpenFile: OpenFile;
}) {
  const daemon = useDaemonStore();
  // The run's own repository (D10): in a folder the change is read where the run lives.
  const repo = run?.repo;
  return (
    // A run read later names its repository: the change is read there, with a store of its own.
    <ScopeProvider key={repo ?? ""} store={Changes} init={{ daemon, runId, repo, file }}>
      <ShownFile file={file} />
      <ListDetail
        className="review"
        testId="review"
        top={<ChangesTop run={run} runId={runId} />}
        listLabel="changed files and notes"
        detailClass="diff"
        list={<FilesAndNotes runId={runId} repo={repo} onOpenFile={onOpenFile} />}
      >
        <ChangesNotice />
        <ChangesError runId={runId} repo={repo} />
        <DiffSide run={run} runId={runId} />
      </ListDetail>
    </ScopeProvider>
  );
}

/** The route's file is the one shown. */
function ShownFile({ file }: { readonly file: string | undefined }) {
  const show = useChanges((s) => s.show);
  useEffect(() => show(file), [file, show]);
  return null;
}

/* ---------- what the daemon says ---------- */

/** The change of the file shown (its list of files, its diff), or `select`'s part of it. */
function useChange<R>(
  runId: string,
  repo: string | undefined,
  select: (view: RunChangesView | undefined) => R,
): R {
  const { client } = useDaemon("client");
  const file = useChanges((s) => s.file);
  return usePolledSelect(
    reviewKey(repo, runId, file),
    () => client.reviewChanges(runId, file, repo),
    3000,
    select,
  );
}

const NO_NOTES: readonly ReviewNote[] = [];

/** The run's notes, or `select`'s part of them. */
function useNotes<R>(
  runId: string,
  repo: string | undefined,
  select: (notes: readonly ReviewNote[]) => R,
): R {
  const { client } = useDaemon("client");
  return usePolledSelect(
    notesKey(repo, runId),
    () => client.reviewNotes(runId, repo),
    3000,
    (d) => select(d?.notes ?? NO_NOTES),
  );
}

const draftCount = (notes: readonly ReviewNote[]) => notes.filter((n) => n.status === "draft").length;

/** The run's controls, acting through the tab's store (the editor is one of them). */
function useControls(run: Run | undefined, runId: string) {
  const api = useChangesApi();
  const daemon = useDaemonStore();
  const busy = useChanges((s) => s.busy);
  const repo = run?.repo;
  const action = storeAction(api, daemon, busy, api.getState().reload);
  return useRunControls(run ?? { runId, repo, driver: "agent" }, action);
}

/* ---------- the top ---------- */

function ChangesTop({ run, runId }: { readonly run: Run | undefined; readonly runId: string }) {
  const repo = run?.repo;
  const base = useChange(runId, repo, (v) => v?.base);
  const controls = useControls(run, runId);
  const file = useChanges((s) => s.file);
  return (
    <>
      <b>Changes</b>
      {base !== undefined ? <span className="dim mono">against {base.slice(0, 12)}</span> : null}
      <span className="spacer" />
      <Button
        variant="ghost"
        onClick={() => void controls.openEditor(file ? { file } : {})}
        data-testid="review-editor"
      >
        Open in editor
      </Button>
      <SendNotes runId={runId} repo={repo} />
    </>
  );
}

function SendNotes({ runId, repo }: { readonly runId: string; readonly repo: string | undefined }) {
  const drafts = useNotes(runId, repo, draftCount);
  const send = useChanges((s) => s.send);
  return (
    <Button
      variant="primary"
      disabled={drafts === 0}
      onClick={() => void send(drafts)}
      data-testid="send-notes"
    >
      Send {drafts > 0 ? drafts : ""} to agent
    </Button>
  );
}

/* ---------- the list: files, then notes ---------- */

const NO_PATHS: readonly string[] = [];

function FilesAndNotes({
  runId,
  repo,
  onOpenFile,
}: {
  readonly runId: string;
  readonly repo: string | undefined;
  onOpenFile: OpenFile;
}) {
  const paths = useChange(runId, repo, (v) => v?.files.map((f) => f.path) ?? NO_PATHS);
  const read = useChange(runId, repo, (v) => v !== undefined);
  const ids = useNotes(runId, repo, (notes) => notes.map((n) => n.id));
  const onFile = useChanges((s) => s.file !== undefined);
  return (
    <>
      <ListSection>files · {paths.length}</ListSection>
      {paths.map((path) => (
        <FileRow key={path} path={path} runId={runId} repo={repo} onOpenFile={onOpenFile} />
      ))}
      {read && paths.length === 0 ? <EmptyRow>No change yet.</EmptyRow> : null}
      <span className="spacer" />
      <ListSection>notes · {ids.length}</ListSection>
      {ids.map((id) => (
        <NoteRow key={id} id={id} runId={runId} repo={repo} />
      ))}
      {onFile ? null : <WholeChangeNote />}
    </>
  );
}

function FileRow({
  path,
  runId,
  repo,
  onOpenFile,
}: {
  readonly path: string;
  readonly runId: string;
  readonly repo: string | undefined;
  onOpenFile: OpenFile;
}) {
  const f = useChange(runId, repo, (v) => v?.files.find((x) => x.path === path));
  const selected = useChanges((s) => s.file === path);
  const noted = useNotes(runId, repo, (notes) => notes.some((n) => n.file === path));
  if (!f) return null;
  return (
    <ListRow
      className="item"
      selected={selected}
      onSelect={() => onOpenFile(runId, f.path)}
      testId={`file-${f.path}`}
      glyph={<Glyph kind="file" state={f.status} />}
      title={f.path}
      trailing={
        <span className="counts">
          <span className="green">+{f.added}</span> <span className="red">−{f.removed}</span>
          {noted ? <span className="amber"> ✎</span> : null}
        </span>
      }
    />
  );
}

function NoteRow({
  id,
  runId,
  repo,
}: {
  readonly id: string;
  readonly runId: string;
  readonly repo: string | undefined;
}) {
  const n = useNotes(runId, repo, (notes) => notes.find((x) => x.id === id));
  const setStatus = useChanges((s) => s.setStatus);
  if (!n) return null;
  return (
    <ListRow
      className="note-row"
      glyph={<Glyph kind="note" state={n.status} />}
      title={
        <>
          <span className="dim mono">{n.file ? `${n.file}${n.line ? `:${n.line}` : ""}` : "the change"}</span>{" "}
          {n.text}
        </>
      }
      trailing={
        n.status === "sent" ? (
          <Button
            variant="ghost"
            onClick={() => void setStatus(n, "addressed")}
            aria-label={`mark the note on ${n.file ?? "the change"} addressed`}
            title="mark addressed"
          >
            ✓
          </Button>
        ) : n.status === "addressed" ? (
          <Button
            variant="ghost"
            onClick={() => void setStatus(n, "draft")}
            aria-label={`reopen the note on ${n.file ?? "the change"}`}
            title="reopen"
          >
            ↺
          </Button>
        ) : undefined
      }
    />
  );
}

/** A note on the whole change (no file shown): its form, or the button that opens it. */
function WholeChangeNote() {
  const writing = useChanges((s) => s.draft !== undefined && s.draft.line === undefined);
  const openDraft = useChanges((s) => s.openDraft);
  return writing ? (
    <NoteForm label="note on the change" inline={false} />
  ) : (
    <div className="note-form">
      <Button variant="ghost" onClick={() => openDraft({ text: "" })}>
        + note on the whole change
      </Button>
    </div>
  );
}

function NoteForm({ label, inline }: { readonly label: string; readonly inline: boolean }) {
  const text = useChanges((s) => s.draft?.text);
  const writeDraft = useChanges((s) => s.writeDraft);
  const cancelDraft = useChanges((s) => s.cancelDraft);
  const add = useChanges((s) => s.add);
  if (text === undefined) return null;
  return (
    <div className={`note-form${inline ? " inline" : ""}`}>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens on a click; the note is where typing goes
        autoFocus
        rows={inline ? 2 : 3}
        value={text}
        onChange={(e) => writeDraft(e.target.value)}
        aria-label={label}
      />
      <div className="row">
        <Button variant="primary" onClick={() => void add()}>
          Add note
        </Button>
        <Button onClick={cancelDraft}>Cancel</Button>
      </div>
    </div>
  );
}

/* ---------- the right side ---------- */

function ChangesNotice() {
  const notice = useChanges((s) => s.notice);
  const closeNotice = useChanges((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

/** The change could not be read, and there is none to show. */
function ChangesError({ runId, repo }: { readonly runId: string; readonly repo: string | undefined }) {
  const { client } = useDaemon("client");
  const file = useChanges((s) => s.file);
  const changes = usePolled(
    reviewKey(repo, runId, file),
    () => client.reviewChanges(runId, file, repo),
    3000,
  );
  return changes.error && !changes.data ? <div className="banner">{changes.error}</div> : null;
}

function DiffSide({ run, runId }: { readonly run: Run | undefined; readonly runId: string }) {
  const repo = run?.repo;
  const file = useChanges((s) => s.file);
  const read = useChange(runId, repo, (v) => v !== undefined);
  const changed = useChange(runId, repo, (v) => (v?.files.length ?? 0) > 0);
  const diff = useChange(runId, repo, (v) => v?.diff);
  if (!file)
    return (
      <div className="empty">
        <h2>{changed ? "Pick a file" : "No change"}</h2>
        <p>
          A click on a line adds a note there; "Send to agent" delivers every draft note to the run as one
          message.
        </p>
      </div>
    );
  return diff ? (
    <Diff run={run} runId={runId} file={file} diff={diff} />
  ) : (
    <div className="dim file-head">{read ? "no diff for this file" : "loading…"}</div>
  );
}

/** The notes on the lines of `file`, by the line's side and number (`old:12`, `new:14`). */
function notesByLine(
  notes: readonly ReviewNote[],
  file: string,
): Readonly<Record<string, readonly ReviewNote[]>> {
  const by: Record<string, ReviewNote[]> = {};
  for (const n of notes) {
    if (n.file !== file || n.line === undefined) continue;
    const at = `${n.side === "old" ? "old" : "new"}:${n.line}`;
    by[at] = [...(by[at] ?? []), n];
  }
  return by;
}
const NO_LINE_NOTES: readonly ReviewNote[] = [];
const lineAt = (l: DiffLine) => (l.kind === "del" ? `old:${l.old}` : `new:${l.new}`);
const keyOf = (hi: number, l: DiffLine) => `${hi}:${l.kind}-${l.old ?? ""}-${l.new ?? ""}`;

/**
 * One file's diff. The lines are one stop of the Tab key, not thousands: the arrow keys move
 * along them, Enter opens a note on the line the focus is on.
 */
function Diff({
  run,
  runId,
  file,
  diff,
}: {
  readonly run: Run | undefined;
  readonly runId: string;
  readonly file: string;
  readonly diff: FileDiff;
}) {
  const notes = useNotes(runId, run?.repo, (all) => notesByLine(all, file));
  const controls = useControls(run, runId);
  const openEditor = (line: number | undefined) =>
    void controls.openEditor({ file, ...(line ? { line } : {}) });
  const move = (e: React.KeyboardEvent<HTMLElement>) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || !(e.target instanceof HTMLElement) || !e.target.classList.contains("line")) return;
    const lines = [...e.currentTarget.querySelectorAll<HTMLElement>(".line")];
    const next = lines[lines.indexOf(e.target) + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const first = diff.hunks[0]?.lines[0];
  const firstKey = first ? keyOf(0, first) : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the lines, which are buttons
    <div className="lines" onKeyDown={move}>
      <div className="dim mono file-head">
        {file} <span className="green">+{diff.added}</span> <span className="red">−{diff.removed}</span>
      </div>
      {diff.hunks.map((h, hi) => (
        <div key={h.header} className="hunk">
          <div className="hunk-head dim mono">{h.header}</div>
          {h.lines.map((l) => (
            <DiffLineRow
              key={keyOf(hi, l)}
              id={keyOf(hi, l)}
              first={firstKey}
              l={l}
              here={notes[lineAt(l)] ?? NO_LINE_NOTES}
              onOpenEditor={openEditor}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One line: a note opens on it with a click; it draws again only when that note opens or closes. */
export function DiffLineRow({
  id,
  first,
  l,
  here,
  onOpenEditor,
}: {
  readonly id: string;
  /** The first line's key: the Tab key's stop until another line had the focus. */
  readonly first: string;
  readonly l: DiffLine;
  readonly here: readonly ReviewNote[];
  onOpenEditor(line: number | undefined): void;
}) {
  const line = l.kind === "del" ? l.old : l.new;
  const side = l.kind === "del" ? "old" : "new";
  const stop = useChanges((s) => (s.active || first) === id);
  const editing = useChanges((s) => s.draft !== undefined && s.draft.line === line && s.draft.side === side);
  const api = useChangesApi();
  return (
    <div>
      <Button
        className={`line ${l.kind}${here.length > 0 ? " noted" : ""}`}
        tabIndex={stop ? 0 : -1}
        onFocus={() => api.getState().focusLine(id)}
        onClick={() => api.getState().openDraft({ ...(line !== undefined ? { line } : {}), side, text: "" })}
        onDoubleClick={() => onOpenEditor(l.new ?? l.old)}
        title="click or Enter: a note here; double click: open in the editor; ↑ ↓ move"
      >
        <span className="ln">{l.old ?? ""}</span>
        <span className="ln">{l.new ?? ""}</span>
        <span className="mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
        <span className="code">{l.text}</span>
      </Button>
      {here.map((n) => (
        <div key={n.id} className={`inline-note ${n.status}`}>
          <span className="dim">
            {lookOf("note", n.status).glyph} {n.by}
          </span>{" "}
          {n.text}
        </div>
      ))}
      {editing ? <NoteForm label={`note on line ${line}`} inline /> : null}
    </div>
  );
}
