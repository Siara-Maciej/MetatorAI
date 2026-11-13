/**
 * The backlog (S4, design/13 §4, mockup "Backlog"): proposals that wait for your decision and the
 * open tasks in one list; the chosen one on the right with its text, priority, labels, where it
 * points, and the decision. An agent only proposes; the task exists after your "Add".
 */
import { useMemo, useState } from "react";
import type { Issue, IssueRef } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { Glyph } from "../components/glyph.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../components/list-detail.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { type Answer, useAction } from "../hooks.ts";
import {
  duration,
  issueRefText,
  plural,
  refusedForDirtyTree,
  START_FROM_COMMIT,
  workflowChoice,
} from "../model.ts";

const NO_ISSUES: readonly Issue[] = [];
const NO_WORKFLOW = {
  ok: false,
  error: { message: "This repository has no workflow to start a run on. `metator setup` installs them." },
};

export function BacklogScreen({
  onOpenSession,
  initialDraft,
}: {
  onOpenSession(runId: string): void;
  /** A task started from a pane or a step: the form opens with these refs. */
  readonly initialDraft?: { readonly title?: string; readonly refs?: readonly IssueRef[] } | undefined;
}) {
  const { client, repo, run: runOf } = useDaemon();
  const list = usePolled(`issues:${repo ?? ""}`, () => client.issues(repo), 2000);
  const issues = list.data?.issues ?? NO_ISSUES;
  // What an action answered stays until closed: the list's refresh never clears it (D5).
  const action = useAction(list.reload);
  // The workflows this repository has (D5): a run is started on one of them, never on a guess.
  const known = usePolled(`workflows:${repo ?? ""}`, () => client.workflows(repo), 30_000);
  const workflows = (known.data?.workflows ?? []).map((w) => w.id);
  const [wanted, setWanted] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState<boolean>(initialDraft !== undefined);
  const [draft, setDraft] = useState({
    title: initialDraft?.title ?? "",
    body: "",
    priority: "normal" as Issue["priority"],
    labels: "",
  });
  const [showDone, setShowDone] = useState(false);
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
  /** The last start was refused for uncommitted changes: the same start, from the last commit. */
  const [retry, setRetry] = useState<() => void>();
  const act = (fn: (by: string) => Promise<Answer>, again?: () => void) => {
    setRetry(undefined);
    return action.run(fn, {
      who: true,
      onRefused: (error) => {
        if (again && refusedForDirtyTree(error)) setRetry(() => again);
      },
    });
  };
  /** The workflow a run on the task starts with: the chosen one, else the proposing run's, else the default. */
  const workflowOf = (issue: Issue | undefined): string | undefined =>
    workflowChoice(workflows, wanted ?? runOf(issue?.proposedBy?.runId, repo)?.workflow);
  const decide = (issue: Issue, decision: "add" | "drop") =>
    act((by) => client.decideIssue(issue.id, { by, decision }, repo));
  // Added and started in one click; refused for uncommitted changes, the issue stays added and
  // the retry is the plain start.
  const addAndStart = (issue: Issue) =>
    act(
      async (by) => {
        const d = await client.decideIssue(issue.id, { by, decision: "add" }, repo);
        if (!d.ok) return d;
        const workflow = workflowOf(issue);
        if (!workflow) return NO_WORKFLOW;
        return client.startIssue(issue.id, { workflow }, repo);
      },
      () => void start(issue, true),
    );
  const start = (issue: Issue, allowDirty = false): Promise<boolean> =>
    act(
      async () => {
        const workflow = workflowOf(issue);
        if (!workflow) return NO_WORKFLOW;
        const r = await client.startIssue(
          issue.id,
          { workflow, ...(allowDirty ? { allowDirty: true } : {}) },
          repo,
        );
        if (r.ok && r.data) onOpenSession(r.data.runId);
        return r;
      },
      () => void start(issue, true),
    );
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
    <ListRow
      key={i.id}
      className="item"
      selected={current?.id === i.id}
      onSelect={() => setChosen(i.id)}
      testId={`issue-${i.id}`}
      glyph={<Glyph kind="issue" state={i.status} />}
      title={i.title}
      sub={
        i.proposedBy
          ? `${i.proposedBy.agent}${i.proposedBy.runId ? ` · ${taskOf(i.proposedBy.runId)}` : ""}`
          : i.refs.map(issueRefText).join(" · ") || i.id
      }
      trailing={
        <span className={`pr ${i.priority}`}>
          {i.status === "proposed" ? duration(Date.now() - new Date(i.createdAt).getTime()) : i.priority}
        </span>
      }
    />
  );
  const taskOf = (runId: string) => runOf(runId, repo)?.task ?? runId;
  return (
    <ListDetail
      className="backlog"
      testId="backlog"
      listLabel="tasks"
      top={
        <>
          <b>Backlog</b>
          <span className="dim">.metator/issues</span>
          {proposals.length > 0 ? (
            <span className="amber">
              {plural(proposals.length, "proposal")} wait{proposals.length === 1 ? "s" : ""} for you
            </span>
          ) : null}
          <span className="spacer" />
          <RepoSelect />
          <button type="button" onClick={() => setAdding(true)}>
            + task
          </button>
        </>
      }
      list={
        <>
          {proposals.length > 0 ? <ListSection>agents' proposals · {proposals.length}</ListSection> : null}
          {proposals.map(row)}
          <ListSection>open · {open.length}</ListSection>
          {open.map(row)}
          {open.length === 0 && proposals.length === 0 ? (
            <EmptyRow>Nothing open. + task adds one.</EmptyRow>
          ) : null}
          <span className="spacer" />
          {finished.length > 0 ? (
            <>
              <ListRow
                className="item dim"
                onSelect={() => setShowDone(!showDone)}
                title={`finished · ${finished.length} ${showDone ? "▾" : "▸"}`}
              />
              {showDone ? finished.map(row) : null}
            </>
          ) : null}
        </>
      }
    >
      <Notice
        {...action.notice}
        action={retry ? { label: START_FROM_COMMIT, run: retry } : undefined}
        onClose={() => {
          action.notice.onClose();
          setRetry(undefined);
        }}
      />
      {list.error && !list.data ? <div className="banner">{list.error}</div> : null}
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
          <h2 title={current.title}>{current.title}</h2>
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
                <button type="button" onClick={() => act((by) => client.closeIssue(current.id, by, repo))}>
                  Done
                </button>
                <button type="button" onClick={() => act((by) => client.dropIssue(current.id, by, repo))}>
                  Drop
                </button>
              </>
            ) : null}
            {current.status === "proposed" || current.status === "open" ? (
              <label className="wf">
                <span className="dim">a run starts on</span>
                <select
                  aria-label="workflow"
                  value={workflowOf(current) ?? ""}
                  onChange={(e) => setWanted(e.target.value)}
                >
                  {workflows.length === 0 ? <option value="">no workflow in this repository</option> : null}
                  {workflows.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {current.status === "in-progress" ? (
              <button type="button" onClick={() => act((by) => client.closeIssue(current.id, by, repo))}>
                Done
              </button>
            ) : null}
          </div>
          <span className="spacer" />
          <div className="faint">
            An agent only proposes. A task exists after your "Add"; "Add and start a run" also opens a run in
            a new worktree (a new tab).
          </div>
        </>
      ) : (
        <div className="empty">
          <h2>No task</h2>
          <p>+ task adds one; agents' proposals appear here and in the inbox.</p>
        </div>
      )}
    </ListDetail>
  );
}
