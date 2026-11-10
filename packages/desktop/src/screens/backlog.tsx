/**
 * The backlog (S4, design/13 §4, mockup "Backlog"): proposals that wait for your decision and the
 * open tasks in one list; the chosen one on the right with its text, priority, labels, where it
 * points, and the decision. An agent only proposes; the task exists after your "Add".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Issue } from "../api.ts";
import { useDaemon } from "../daemon.tsx";
import { duration, issueRefText } from "../model.ts";

const GLYPH: Record<Issue["status"], string> = {
  proposed: "?",
  "in-progress": "⋮",
  open: "○",
  done: "✓",
  dropped: "✕",
};

export function BacklogScreen({
  onOpenSession,
  initialDraft,
}: {
  onOpenSession(runId: string): void;
  /** A task started from a pane or a step: the form opens with these refs. */
  readonly initialDraft?: { readonly title?: string; readonly refs?: Issue["refs"] } | undefined;
}) {
  const { client, repos, runs, me, setMe } = useDaemon();
  const repo = repos[0]?.name;
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState<boolean>(initialDraft !== undefined);
  const [draft, setDraft] = useState({
    title: initialDraft?.title ?? "",
    body: "",
    priority: "normal" as Issue["priority"],
    labels: "",
  });
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(async () => {
    const r = await client.issues(repo);
    if (r.ok && r.data) {
      setIssues(r.data.issues);
      setError(undefined);
    } else setError(r.error?.message ?? "no backlog");
  }, [client, repo]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);
  const proposals = useMemo(() => issues.filter((i) => i.status === "proposed"), [issues]);
  const open = useMemo(
    () => issues.filter((i) => i.status === "open" || i.status === "in-progress"),
    [issues],
  );
  const finished = useMemo(
    () => issues.filter((i) => i.status === "done" || i.status === "dropped"),
    [issues],
  );
  const current = issues.find((i) => i.id === chosen) ?? proposals[0] ?? open[0];
  const who = () => {
    const name = me || window.prompt("your name") || "";
    if (name) setMe(name);
    return name;
  };
  const act = async (fn: (by: string) => Promise<{ ok: boolean; error?: { message: string } }>) => {
    const by = who();
    if (!by) return;
    const r = await fn(by);
    if (!r.ok) setError(r.error?.message);
    else await load();
  };
  const decide = (issue: Issue, decision: "add" | "drop") =>
    act((by) => client.decideIssue(issue.id, { by, decision }, repo));
  const addAndStart = (issue: Issue) =>
    act(async (by) => {
      const d = await client.decideIssue(issue.id, { by, decision: "add" }, repo);
      if (!d.ok) return d;
      return client.startIssue(
        issue.id,
        { workflow: runs.find((r) => r.runId === issue.proposedBy?.runId)?.workflow ?? "mt-feature" },
        repo,
      );
    });
  const start = (issue: Issue) =>
    act(async () => {
      const r = await client.startIssue(issue.id, { workflow: runs[0]?.workflow ?? "mt-feature" }, repo);
      if (r.ok && r.data) onOpenSession(r.data.runId);
      return r;
    });
  const add = () =>
    act(async (by) => {
      const r = await client.addIssue(
        {
          title: draft.title.trim(),
          body: draft.body,
          priority: draft.priority,
          labels: draft.labels
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== ""),
          refs: initialDraft?.refs ?? [],
          by,
        },
        repo,
      );
      if (r.ok) {
        setAdding(false);
        setDraft({ title: "", body: "", priority: "normal", labels: "" });
        if (r.data) setChosen(r.data.id);
      }
      return r;
    });
  const row = (i: Issue) => (
    <button
      type="button"
      key={i.id}
      className={`item${current?.id === i.id ? " sel" : ""}`}
      aria-current={current?.id === i.id ? "true" : undefined}
      onClick={() => setChosen(i.id)}
      data-testid={`issue-${i.id}`}
    >
      <span className={`g ${i.status}`}>{GLYPH[i.status]}</span>
      <span className="n">
        {i.title}
        <span className="sub dim">
          {i.proposedBy
            ? `${i.proposedBy.agent}${i.proposedBy.runId ? ` · ${taskOf(i.proposedBy.runId)}` : ""}`
            : i.refs.map(issueRefText).join(" · ") || i.id}
        </span>
      </span>
      <span className={`pr ${i.priority}`}>
        {i.status === "proposed" ? duration(Date.now() - new Date(i.createdAt).getTime()) : i.priority}
      </span>
    </button>
  );
  const taskOf = (runId: string) => runs.find((r) => r.runId === runId)?.task ?? runId;
  return (
    <div className="backlog" data-testid="backlog">
      <div className="top">
        <b>Backlog</b>
        <span className="dim">.metator/issues</span>
        {proposals.length > 0 ? (
          <span className="amber">
            {proposals.length} proposal{proposals.length === 1 ? "" : "s"} wait
            {proposals.length === 1 ? "s" : ""} for you
          </span>
        ) : null}
        <span className="spacer" />
        <button type="button" onClick={() => setAdding(true)}>
          + task
        </button>
      </div>
      <div className="body">
        <aside className="list">
          {proposals.length > 0 ? <div className="sec">agents' proposals · {proposals.length}</div> : null}
          {proposals.map(row)}
          <div className="sec">open · {open.length}</div>
          {open.map(row)}
          {open.length === 0 && proposals.length === 0 ? (
            <div className="dim" style={{ padding: "6px 20px" }}>
              Nothing open. + task adds one.
            </div>
          ) : null}
          <span className="spacer" />
          {finished.length > 0 ? (
            <>
              <button type="button" className="item dim" onClick={() => setShowDone(!showDone)}>
                <span className="g" />
                <span className="n">
                  finished · {finished.length} {showDone ? "▾" : "▸"}
                </span>
              </button>
              {showDone ? finished.map(row) : null}
            </>
          ) : null}
        </aside>
        <main className="detail">
          {error ? <div className="banner">{error}</div> : null}
          {adding ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <div className="dim">a new task · yours</div>
              <label>
                <span className="dim">title</span>
                <input
                  // biome-ignore lint/a11y/noAutofocus: the form opens on a click; the title is where typing goes
                  autoFocus
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  required
                />
              </label>
              <label>
                <span className="dim">what and why</span>
                <textarea
                  rows={5}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </label>
              <div className="row">
                <label>
                  <span className="dim">priority</span>
                  <select
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: e.target.value as Issue["priority"] })}
                  >
                    <option value="low">low</option>
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                  </select>
                </label>
                <label>
                  <span className="dim">labels</span>
                  <input
                    value={draft.labels}
                    onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
                    placeholder="billing, tests"
                  />
                </label>
              </div>
              {initialDraft?.refs && initialDraft.refs.length > 0 ? (
                <div className="dim">points at: {initialDraft.refs.map(issueRefText).join(" · ")}</div>
              ) : null}
              <div className="actions">
                <button type="submit" className="go">
                  Add
                </button>
                <button type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : current ? (
            <>
              <div className="dim">
                {current.status === "proposed" && current.proposedBy
                  ? `proposal · ${current.proposedBy.agent}${current.proposedBy.runId ? ` · ${taskOf(current.proposedBy.runId)}` : ""}`
                  : `${current.id} · ${current.status}${current.decidedBy ? ` · ${current.decidedBy.decision} by ${current.decidedBy.by}` : ""}`}
              </div>
              <h2>{current.title}</h2>
              {current.body ? <p className="text">{current.body}</p> : null}
              <div className="row">
                <span className="dim">priority</span>{" "}
                <span className={`pr ${current.priority}`}>{current.priority}</span>
                <span className="dim">labels</span> <span>{current.labels.join(", ") || "—"}</span>
              </div>
              {current.refs.length > 0 ? (
                <div className="dim mono">refs: {current.refs.map(issueRefText).join(" · ")}</div>
              ) : null}
              {current.runId ? (
                <div className="dim">
                  run:{" "}
                  <button
                    type="button"
                    className="ghost mono"
                    onClick={() => onOpenSession(current.runId as string)}
                  >
                    {taskOf(current.runId)}
                  </button>
                </div>
              ) : null}
              <div className="actions">
                {current.status === "proposed" ? (
                  <>
                    <button type="button" className="go" onClick={() => void decide(current, "add")}>
                      Add
                    </button>
                    <button type="button" onClick={() => void addAndStart(current)}>
                      Add and start a run
                    </button>
                    <button type="button" onClick={() => void decide(current, "drop")}>
                      Drop
                    </button>
                  </>
                ) : null}
                {current.status === "open" ? (
                  <>
                    <button type="button" className="go" onClick={() => void start(current)}>
                      Start a run
                    </button>
                    <button
                      type="button"
                      onClick={() => act((by) => client.closeIssue(current.id, by, repo))}
                    >
                      Done
                    </button>
                    <button type="button" onClick={() => act((by) => client.dropIssue(current.id, by, repo))}>
                      Drop
                    </button>
                  </>
                ) : null}
                {current.status === "in-progress" ? (
                  <button type="button" onClick={() => act((by) => client.closeIssue(current.id, by, repo))}>
                    Done
                  </button>
                ) : null}
              </div>
              <span className="spacer" />
              <div className="dim" style={{ fontSize: 12 }}>
                An agent only proposes. A task exists after your "Add"; "Add and start a run" also opens a run
                in a new worktree (a new tab).
              </div>
            </>
          ) : (
            <div className="empty">
              <h2>No task</h2>
              <p>+ task adds one; agents' proposals appear here and in the inbox.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
