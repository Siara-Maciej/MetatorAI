/**
 * The change of a run with your notes on it (S5, design/13 §5): the files on the left with their
 * line counts, one file's diff on the right; a click on a line opens a note there; the notes go
 * to the run's agents as one message with "Send to agent". Nothing here edits the code.
 */
import { useState } from "react";
import type { DiffLine, FileDiff, ReviewNote } from "../api.ts";
import { Notice } from "../components/common.tsx";
import { Glyph } from "../components/glyph.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../components/list-detail.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction, useRunControls } from "../hooks.ts";
import { lookOf, plural, type Run } from "../model.ts";

interface Draft {
  readonly line?: number;
  readonly side?: "old" | "new";
  readonly text: string;
}

export function ChangesTab({
  run,
  runId,
  file,
  onOpenFile,
}: {
  readonly run: Run | undefined;
  readonly runId: string;
  readonly file?: string | undefined;
  onOpenFile(runId: string, file?: string): void;
}) {
  const { client } = useDaemon();
  // The run's own repository (D10): in a folder the change is read where the run lives.
  const repo = run?.repo;
  const key = `review:${repo ?? ""}:${runId}:${file ?? ""}`;
  const changes = usePolled(key, () => client.reviewChanges(runId, file, repo), 3000);
  const noted = usePolled(`notes:${repo ?? ""}:${runId}`, () => client.reviewNotes(runId, repo), 3000);
  const view = changes.data;
  const notes = noted.data?.notes ?? [];
  // What an action answered stays until closed: a refresh never clears it (D5).
  const action = useAction(() => Promise.all([changes.reload(), noted.reload()]));
  const controls = useRunControls(run ?? { runId, repo, driver: "agent" }, action);
  const [draft, setDraft] = useState<Draft>();
  const add = async () => {
    if (!draft || draft.text.trim() === "") return;
    const ok = await action.run(
      (by) =>
        client.addNote(
          runId,
          {
            text: draft.text,
            by,
            ...(file ? { file } : {}),
            ...(draft.line ? { line: draft.line, side: draft.side ?? "new" } : {}),
          },
          repo,
        ),
      { who: true },
    );
    if (ok) setDraft(undefined);
  };
  const drafts = notes.filter((n) => n.status === "draft");
  const send = () =>
    action.run((by) => client.sendNotes(runId, by, repo), {
      who: true,
      done: `sent ${plural(drafts.length, "note")} to the run`,
    });
  const setStatus = (n: ReviewNote, status: ReviewNote["status"]) =>
    action.run(() => client.setNoteStatus(runId, n.id, status, repo));
  const openEditor = (line?: number) =>
    controls.openEditor({ ...(file ? { file } : {}), ...(line ? { line } : {}) });
  const noteForm = (label: string, inline: boolean) =>
    draft ? (
      <div className={`note-form${inline ? " inline" : ""}`}>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the form opens on a click; the note is where typing goes
          autoFocus
          rows={inline ? 2 : 3}
          value={draft.text}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          aria-label={label}
        />
        <div className="row">
          <button type="button" className="primary" onClick={() => void add()}>
            Add note
          </button>
          <button type="button" onClick={() => setDraft(undefined)}>
            Cancel
          </button>
        </div>
      </div>
    ) : null;
  return (
    <ListDetail
      className="review"
      testId="review"
      top={
        <>
          <b>Changes</b>
          {view ? <span className="dim mono">against {view.base.slice(0, 12)}</span> : null}
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            onClick={() => void openEditor()}
            data-testid="review-editor"
          >
            Open in editor
          </button>
          <button
            type="button"
            className="primary"
            disabled={drafts.length === 0}
            onClick={() => void send()}
            data-testid="send-notes"
          >
            Send {drafts.length > 0 ? drafts.length : ""} to agent
          </button>
        </>
      }
      listLabel="changed files and notes"
      detailClass="diff"
      list={
        <>
          <ListSection>files · {view?.files.length ?? 0}</ListSection>
          {view?.files.map((f) => (
            <ListRow
              key={f.path}
              className="item"
              selected={f.path === file}
              onSelect={() => onOpenFile(runId, f.path)}
              testId={`file-${f.path}`}
              glyph={<Glyph kind="file" state={f.status} />}
              title={f.path}
              trailing={
                <span className="counts">
                  <span className="green">+{f.added}</span> <span className="red">−{f.removed}</span>
                  {notes.some((n) => n.file === f.path) ? <span className="amber"> ✎</span> : null}
                </span>
              }
            />
          ))}
          {view && view.files.length === 0 ? <EmptyRow>No change yet.</EmptyRow> : null}
          <span className="spacer" />
          <ListSection>notes · {notes.length}</ListSection>
          {notes.map((n) => (
            <ListRow
              key={n.id}
              className="note-row"
              glyph={<Glyph kind="note" state={n.status} />}
              title={
                <>
                  <span className="dim mono">
                    {n.file ? `${n.file}${n.line ? `:${n.line}` : ""}` : "the change"}
                  </span>{" "}
                  {n.text}
                </>
              }
              trailing={
                n.status === "sent" ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void setStatus(n, "addressed")}
                    aria-label={`mark the note on ${n.file ?? "the change"} addressed`}
                    title="mark addressed"
                  >
                    ✓
                  </button>
                ) : n.status === "addressed" ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void setStatus(n, "draft")}
                    aria-label={`reopen the note on ${n.file ?? "the change"}`}
                    title="reopen"
                  >
                    ↺
                  </button>
                ) : undefined
              }
            />
          ))}
          {!file ? (
            draft && draft.line === undefined ? (
              noteForm("note on the change", false)
            ) : (
              <div className="note-form">
                <button type="button" className="ghost" onClick={() => setDraft({ text: "" })}>
                  + note on the whole change
                </button>
              </div>
            )
          ) : null}
        </>
      }
    >
      <Notice {...action.notice} />
      {changes.error && !view ? <div className="banner">{changes.error}</div> : null}
      {!file ? (
        <div className="empty">
          <h2>{view?.files.length ? "Pick a file" : "No change"}</h2>
          <p>
            A click on a line adds a note there; "Send to agent" delivers every draft note to the run as one
            message.
          </p>
        </div>
      ) : view?.diff ? (
        <Diff
          file={file}
          diff={view.diff}
          notes={notes.filter((n) => n.file === file && n.line !== undefined)}
          draft={draft}
          onDraft={setDraft}
          onOpenEditor={(line) => void openEditor(line)}
          form={(line) => noteForm(`note on line ${line}`, true)}
        />
      ) : (
        <div className="dim file-head">{view ? "no diff for this file" : "loading…"}</div>
      )}
    </ListDetail>
  );
}

/**
 * One file's diff. The lines are one stop of the Tab key, not thousands: the arrow keys move
 * along them, Enter opens a note on the line the focus is on.
 */
function Diff({
  file,
  diff,
  notes,
  draft,
  onDraft,
  onOpenEditor,
  form,
}: {
  readonly file: string;
  readonly diff: FileDiff;
  readonly notes: readonly ReviewNote[];
  readonly draft: Draft | undefined;
  onDraft(draft: Draft): void;
  onOpenEditor(line: number | undefined): void;
  form(line: number | undefined): React.ReactNode;
}) {
  const [active, setActive] = useState("");
  const notesAt = (l: DiffLine) =>
    notes.filter((n) =>
      l.kind === "del" ? n.side === "old" && n.line === l.old : n.side !== "old" && n.line === l.new,
    );
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
  const firstKey = first ? `0:${first.kind}-${first.old ?? ""}-${first.new ?? ""}` : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys move between the lines, which are buttons
    <div className="lines" onKeyDown={move}>
      <div className="dim mono file-head">
        {file} <span className="green">+{diff.added}</span> <span className="red">−{diff.removed}</span>
      </div>
      {diff.hunks.map((h, hi) => (
        <div key={h.header} className="hunk">
          <div className="hunk-head dim mono">{h.header}</div>
          {h.lines.map((l) => {
            const line = l.kind === "del" ? l.old : l.new;
            const side = l.kind === "del" ? "old" : "new";
            const here = notesAt(l);
            const key = `${hi}:${l.kind}-${l.old ?? ""}-${l.new ?? ""}`;
            const editing = draft !== undefined && draft.line === line && draft.side === side;
            return (
              <div key={key}>
                <button
                  type="button"
                  className={`line ${l.kind}${here.length > 0 ? " noted" : ""}`}
                  tabIndex={key === (active || firstKey) ? 0 : -1}
                  onFocus={() => setActive(key)}
                  onClick={() => onDraft({ ...(line !== undefined ? { line } : {}), side, text: "" })}
                  onDoubleClick={() => onOpenEditor(l.new ?? l.old)}
                  title="click or Enter: a note here; double click: open in the editor; ↑ ↓ move"
                >
                  <span className="ln">{l.old ?? ""}</span>
                  <span className="ln">{l.new ?? ""}</span>
                  <span className="mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                  <span className="code">{l.text}</span>
                </button>
                {here.map((n) => (
                  <div key={n.id} className={`inline-note ${n.status}`}>
                    <span className="dim">
                      {lookOf("note", n.status).glyph} {n.by}
                    </span>{" "}
                    {n.text}
                  </div>
                ))}
                {editing ? form(line) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
