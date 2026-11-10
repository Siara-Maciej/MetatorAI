/**
 * The change of a run with your notes on it (S5, design/13 §5): the files on the left with their
 * line counts, one file's diff on the right; a click on a line opens a note there; the notes go
 * to the run's agents as one message with "Send to agent". Nothing here edits the code.
 */
import { useCallback, useEffect, useState } from "react";
import type { DiffLine, ReviewNote, RunChangesView } from "../api.ts";
import { useDaemon } from "../daemon.tsx";

const STATUS_GLYPH: Record<ReviewNote["status"], string> = { draft: "✎", sent: "→", addressed: "✓" };

export function ReviewScreen({
  runId,
  file,
  onOpenFile,
  onOpenSession,
}: {
  readonly runId: string;
  readonly file?: string | undefined;
  onOpenFile(runId: string, file?: string): void;
  onOpenSession(runId: string): void;
}) {
  const { client, repos, runs, me, setMe } = useDaemon();
  const repo = repos[0]?.name;
  const run = runs.find((r) => r.runId === runId);
  const [view, setView] = useState<RunChangesView>();
  const [notes, setNotes] = useState<readonly ReviewNote[]>([]);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<{ line?: number; side?: "old" | "new"; text: string }>();
  const [note, setNote] = useState<string>();
  const load = useCallback(async () => {
    const [c, n] = await Promise.all([
      client.reviewChanges(runId, file, repo),
      client.reviewNotes(runId, repo),
    ]);
    if (c.ok && c.data) {
      setView(c.data);
      setError(undefined);
    } else setError(c.error?.message ?? "no change");
    if (n.ok && n.data) setNotes(n.data.notes);
  }, [client, runId, file, repo]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);
  const who = () => {
    const name = me || window.prompt("your name") || "";
    if (name) setMe(name);
    return name;
  };
  const add = async () => {
    if (!draft || draft.text.trim() === "") return;
    const by = who();
    if (!by) return;
    const r = await client.addNote(
      runId,
      {
        text: draft.text,
        by,
        ...(file ? { file } : {}),
        ...(draft.line ? { line: draft.line, side: draft.side ?? "new" } : {}),
      },
      repo,
    );
    if (r.ok) {
      setDraft(undefined);
      await load();
    } else setError(r.error?.message);
  };
  const send = async () => {
    const by = who();
    if (!by) return;
    const r = await client.sendNotes(runId, by, repo);
    if (r.ok && r.data)
      setNote(
        `sent ${r.data.notes.length} note${r.data.notes.length === 1 ? "" : "s"} to the run as ${r.data.message.id}`,
      );
    else setError(r.error?.message);
    await load();
  };
  const setStatus = async (n: ReviewNote, status: ReviewNote["status"]) => {
    const r = await client.setNoteStatus(runId, n.id, status, repo);
    if (!r.ok) setError(r.error?.message);
    await load();
  };
  const openEditor = async (line?: number) => {
    const r = await client.openEditor(runId, { ...(file ? { file } : {}), ...(line ? { line } : {}) }, repo);
    setNote(r.ok ? `opened in the editor: ${file ?? view?.dir ?? ""}` : r.error?.message);
  };
  const drafts = notes.filter((n) => n.status === "draft");
  const notesAt = (l: DiffLine) =>
    notes.filter(
      (n) =>
        n.file === file &&
        n.line !== undefined &&
        (l.kind === "del" ? n.side === "old" && n.line === l.old : n.side !== "old" && n.line === l.new),
    );
  return (
    <div className="review" data-testid="review">
      <div className="top">
        <b>Changes</b>
        <button type="button" className="ghost mono" onClick={() => onOpenSession(runId)} title="the session">
          {run?.task ?? runId}
        </button>
        {view ? <span className="dim mono">against {view.base.slice(0, 12)}</span> : null}
        <span className="spacer" />
        {note ? <span className="dim">{note}</span> : null}
        <button type="button" className="ghost" onClick={() => void openEditor()} data-testid="review-editor">
          Open in editor
        </button>
        <button
          type="button"
          className="go"
          disabled={drafts.length === 0}
          onClick={() => void send()}
          data-testid="send-notes"
        >
          Send {drafts.length > 0 ? drafts.length : ""} to agent
        </button>
      </div>
      <div className="body">
        <aside className="files">
          <div className="sec">files · {view?.files.length ?? 0}</div>
          {view?.files.map((f) => (
            <button
              type="button"
              key={f.path}
              className={`item${f.path === file ? " sel" : ""}`}
              aria-current={f.path === file ? "true" : undefined}
              onClick={() => onOpenFile(runId, f.path)}
              data-testid={`file-${f.path}`}
            >
              <span className={`g ${f.status}`}>
                {f.status === "added"
                  ? "A"
                  : f.status === "deleted"
                    ? "D"
                    : f.status === "renamed"
                      ? "R"
                      : "M"}
              </span>
              <span className="n">{f.path}</span>
              <span className="counts">
                <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                {notes.some((n) => n.file === f.path) ? <span className="amber"> ✎</span> : null}
              </span>
            </button>
          ))}
          {view && view.files.length === 0 ? (
            <div className="dim" style={{ padding: "6px 20px" }}>
              No change yet.
            </div>
          ) : null}
          <span className="spacer" />
          <div className="sec">notes · {notes.length}</div>
          {notes.map((n) => (
            <div key={n.id} className="note-row">
              <span className={`g ${n.status}`}>{STATUS_GLYPH[n.status]}</span>
              <span className="n">
                <span className="dim mono">
                  {n.file ? `${n.file}${n.line ? `:${n.line}` : ""}` : "the change"}
                </span>{" "}
                {n.text}
              </span>
              {n.status === "sent" ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void setStatus(n, "addressed")}
                  title="mark addressed"
                >
                  ✓
                </button>
              ) : null}
              {n.status === "addressed" ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void setStatus(n, "draft")}
                  title="reopen"
                >
                  ↺
                </button>
              ) : null}
            </div>
          ))}
          {!file ? (
            <div className="note-form">
              {draft && draft.line === undefined ? (
                <>
                  <textarea
                    rows={3}
                    value={draft.text}
                    onChange={(e) => setDraft({ text: e.target.value })}
                    aria-label="note on the change"
                  />
                  <div className="row">
                    <button type="button" className="go" onClick={() => void add()}>
                      Add note
                    </button>
                    <button type="button" onClick={() => setDraft(undefined)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className="ghost" onClick={() => setDraft({ text: "" })}>
                  + note on the whole change
                </button>
              )}
            </div>
          ) : null}
        </aside>
        <main className="diff">
          {error ? <div className="banner">{error}</div> : null}
          {!file ? (
            <div className="empty">
              <h2>{view?.files.length ? "Pick a file" : "No change"}</h2>
              <p>
                A click on a line adds a note there; "Send to agent" delivers every draft note to the run as
                one message.
              </p>
            </div>
          ) : view?.diff ? (
            <>
              <div className="dim mono file-head">
                {file} <span className="plus">+{view.diff.added}</span>{" "}
                <span className="minus">−{view.diff.removed}</span>
              </div>
              {view.diff.hunks.map((h) => (
                <div key={h.header} className="hunk">
                  <div className="hunk-head dim mono">{h.header}</div>
                  {h.lines.map((l) => {
                    const line = l.kind === "del" ? l.old : l.new;
                    const side = l.kind === "del" ? "old" : "new";
                    const here = notesAt(l);
                    const editing = draft && draft.line === line && draft.side === side;
                    return (
                      <div key={`${l.kind}-${l.old ?? ""}-${l.new ?? ""}`}>
                        <button
                          type="button"
                          className={`line ${l.kind}${here.length > 0 ? " noted" : ""}`}
                          onClick={() =>
                            setDraft({ ...(line !== undefined ? { line } : {}), side, text: "" })
                          }
                          onDoubleClick={() => void openEditor(l.new ?? l.old)}
                          title="click: a note here; double click: open in the editor"
                        >
                          <span className="ln">{l.old ?? ""}</span>
                          <span className="ln">{l.new ?? ""}</span>
                          <span className="mark">
                            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                          </span>
                          <span className="code">{l.text}</span>
                        </button>
                        {here.map((n) => (
                          <div key={n.id} className={`inline-note ${n.status}`}>
                            <span className="dim">
                              {STATUS_GLYPH[n.status]} {n.by}
                            </span>{" "}
                            {n.text}
                          </div>
                        ))}
                        {editing ? (
                          <div className="note-form inline">
                            <textarea
                              // biome-ignore lint/a11y/noAutofocus: the form opens on a click on the line
                              autoFocus
                              rows={2}
                              value={draft.text}
                              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                              aria-label={`note on line ${line}`}
                            />
                            <div className="row">
                              <button type="button" className="go" onClick={() => void add()}>
                                Add note
                              </button>
                              <button type="button" onClick={() => setDraft(undefined)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          ) : (
            <div className="dim">{view ? "no diff for this file" : "loading…"}</div>
          )}
        </main>
      </div>
    </div>
  );
}
