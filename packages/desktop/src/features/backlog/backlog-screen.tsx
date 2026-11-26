/**
 * The backlog (S4, design/13 §4, mockup "Backlog"): proposals that wait for your decision and the
 * open tasks in one list, a parent's children right under it; the chosen one on the right with its
 * text, its analysis and its plan (each with a freshness badge), its children and what each waits
 * for, and the decision. An agent only proposes; the task exists after your "Add". Analyse, Make
 * plan and Implement each start an agent in a terminal of its own, and the app shows it (round 17).
 */
import { useEffect, useMemo, useState } from "react";
import type { Issue, IssueView, PlanStarted } from "../../shared/api/api.ts";
import { Freshness } from "../../shared/components/freshness.tsx";
import { Glyph } from "../../shared/components/glyph.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { confirmed } from "../../shared/confirm.ts";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { type Answer, useAction } from "../../shared/hooks.ts";
import { duration, issueRefText, plural } from "../../shared/model/format.ts";
import { readingOf } from "../../shared/model/freshness.ts";
import { workflowChoice } from "../../shared/model/runs.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { refusedForDirtyTree, START_FROM_COMMIT } from "../runs/model.ts";
import { useOpenRun } from "../runs/open-run.ts";
import { RunLink } from "../runs/run-link.tsx";
import { dropBacklogDraft, useBacklogDraft } from "./draft.ts";
import { AnalysisPart, ChildrenPart, ItemAction, ParentLine, PlanPart } from "./item-parts.tsx";
import {
  backlogRows,
  finishQuestion,
  itemButtons,
  itemTone,
  itemWord,
  type ListRowOf,
  newTaskProblem,
  pointsAt,
  rowSub,
  shownRoute,
  whyDisabled,
} from "./model.ts";

const NO_ISSUES: readonly IssueView[] = [];
const NO_WORKFLOW = {
  ok: false,
  error: { message: "This repository has no workflow to start a run on. `metator setup` installs them." },
};
export function BacklogScreen({
  id,
}: {
  /** The item chosen by the route (a plan view's "Open its Backlog item"). */
  readonly id?: string | undefined;
}) {
  const openRun = useOpenRun();
  const onOpenSession = (runId: string) => openRun(runId);
  // "New task from here…": the draft lives until the Backlog is left.
  const initialDraft = useBacklogDraft();
  useEffect(() => dropBacklogDraft, []);
  const { client, repo, run: runOf } = useDaemon("client", "repo", "run");
  const list = usePolled(`issues:${repo ?? ""}`, () => client.issues(repo), 2000);
  const issues = list.data?.issues ?? NO_ISSUES;
  const reading = readingOf(list);
  // What an action answered stays until closed: the list's refresh never clears it (D5).
  const action = useAction(list.reload);
  // The workflows this repository has (D5): a run is started on one of them, never on a guess.
  const known = usePolled(`workflows:${repo ?? ""}`, () => client.workflows(repo), 30_000);
  const workflows = (known.data?.workflows ?? []).map((w) => w.id);
  const [wanted, setWanted] = useState<string>();
  const [picked, setChosen] = useState<string>();
  // The route's item wins when the route changes (a plan view's "Open its Backlog item").
  useEffect(() => {
    if (id) setChosen(undefined);
  }, [id]);
  const chosen = picked ?? id;
  const [adding, setAdding] = useState<boolean>(initialDraft !== undefined);
  const [draft, setDraft] = useState({
    title: initialDraft?.title ?? "",
    body: "",
    priority: "normal" as Issue["priority"],
    labels: "",
  });
  const [showDone, setShowDone] = useState(false);
  // A parent's children sit right under it, in its part of the list.
  const rows = useMemo(() => backlogRows(issues), [issues]);
  const proposals = rows.proposals.filter((r) => !r.child).map((r) => r.item);
  const open = rows.open.filter((r) => !r.child).map((r) => r.item);
  const finished = rows.finished;
  const current = issues.find((i) => i.id === chosen) ?? proposals[0] ?? open[0];
  const buttons = current ? itemButtons(current, issues) : {};
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
  const addAndStart = (issue: IssueView) =>
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
  /**
   * Implement: with a plan the daemon starts from it (a fresh one at build, a stale one at plan
   * review) on the plan run's workflow unless the person chose one, a part made from a system plan
   * step starts that step; the conductor's terminal shows.
   */
  const start = (issue: IssueView, allowDirty = false): Promise<boolean> =>
    act(
      async () => {
        // A plan, or a system plan step (a part made from one), names its own workflow.
        const own = issue.plan !== undefined || issue.step !== undefined;
        const workflow = own && !wanted ? undefined : workflowOf(issue);
        if (!workflow && !own) return NO_WORKFLOW;
        const r = await client.startIssue(
          issue.id,
          { ...(workflow ? { workflow } : {}), ...(allowDirty ? { allowDirty: true } : {}) },
          repo,
        );
        if (r.ok && r.data) show(r.data.runId, r.data);
        return r;
      },
      () => void start(issue, true),
    );
  /** The terminal of the agent a button started, at once; a run with no pane opens its page. */
  const show = (
    runId: string | undefined,
    started: Partial<Pick<PlanStarted, "session">> & { readonly paneId?: string },
  ) => {
    const to = shownRoute({ runId, paneId: started.session?.paneId ?? started.paneId });
    if (to) navigate(to);
    else if (runId) onOpenSession(runId);
  };
  /**
   * Analyse opens an mt-guide pane, Make plan a run `--until plan` with its conductor: the app shows
   * that terminal (as "+ New chat" opens its thread). Plans change only through the agent.
   */
  const analyse = (issue: IssueView) =>
    act(async (by) => {
      const r = await client.analyzeIssue(issue.id, { by }, repo);
      if (r.ok && r.data) show(r.data.pane.runId, { paneId: r.data.pane.id });
      return r;
    });
  const makePlan = (issue: IssueView) =>
    act(async (by) => {
      const r = await client.planIssue(issue.id, { by }, repo);
      if (r.ok && r.data) show(r.data.runId, r.data);
      return r;
    });
  const add = () => {
    const problem = newTaskProblem(draft.title);
    if (problem) {
      action.say(problem);
      return;
    }
    return act(async (by) => {
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
  };
  /** Done and Drop cannot be taken back in the app: asked first. */
  const finish = (issue: IssueView, how: "done" | "drop") => {
    if (!confirmed(finishQuestion(issue, how))) return;
    void act((by) =>
      how === "done" ? client.closeIssue(issue.id, by, repo) : client.dropIssue(issue.id, by, repo),
    );
  };
  const row = ({ item: i, child }: ListRowOf<IssueView>) => {
    const word = itemWord(i);
    return (
      <ListRow
        key={i.id}
        className={`item${child ? " child" : ""}`}
        selected={current?.id === i.id}
        onSelect={() => setChosen(i.id)}
        testId={`issue-${i.id}`}
        glyph={<Glyph kind="issue" state={i.status} />}
        title={i.title}
        sub={
          i.proposedBy && i.status === "proposed"
            ? `${i.proposedBy.agent}${i.proposedBy.runId ? ` · ${taskOf(i.proposedBy.runId)}` : ""}`
            : rowSub(i, issues)
        }
        trailing={
          i.status === "proposed" ? (
            <span className={`pr ${i.priority}`}>
              {duration(Date.now() - new Date(i.createdAt).getTime())}
            </span>
          ) : (
            <span className={`word ${itemTone(word)}`}>{word}</span>
          )
        }
      />
    );
  };
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
          <Button onClick={() => setAdding(true)}>+ task</Button>
        </>
      }
      list={
        <>
          {proposals.length > 0 ? <ListSection>agents' proposals · {proposals.length}</ListSection> : null}
          {rows.proposals.map(row)}
          <ListSection>open · {open.length}</ListSection>
          {rows.open.map(row)}
          {/* Empty only when the daemon said so: not while it is read, not when it failed. */}
          {reading === "loading" ? <EmptyRow>Reading the tasks…</EmptyRow> : null}
          {reading !== "loading" && reading !== "failed" && open.length === 0 && proposals.length === 0 ? (
            <EmptyRow>Nothing open. + task adds one.</EmptyRow>
          ) : null}
          <span className="spacer" />
          {finished.some((r) => !r.child) ? (
            <>
              <ListRow
                className="item dim"
                onSelect={() => setShowDone(!showDone)}
                title={`finished · ${finished.filter((r) => !r.child).length} ${showDone ? "▾" : "▸"}`}
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
      <Freshness reads={[list]} what="The tasks" />
      {adding ? (
        <form
          className="form"
          aria-label="a new task"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          onKeyDown={(e) => {
            // Escape leaves the form as Cancel does.
            if (e.key === "Escape") {
              e.preventDefault();
              setAdding(false);
            }
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
                aria-label="priority"
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
            <Button type="submit" variant="primary">
              Add
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : current ? (
        <div className="item-detail" data-testid="item-detail">
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
          {/* What it points at: files as text, runs by their task (the plan's own run is under Plan). */}
          {pointsAt(current).files.length > 0 ? (
            <div className="dim mono">points at: {pointsAt(current).files.map(issueRefText).join(" · ")}</div>
          ) : null}
          {pointsAt(current).runs.map((r) => (
            <div key={r} className="dim">
              from: <RunLink runId={r} repo={repo} onOpen={onOpenSession} />
            </div>
          ))}
          {current.runId ? (
            <div className="dim">
              run: <RunLink runId={current.runId} repo={repo} onOpen={onOpenSession} />
            </div>
          ) : null}
          {current.parent ? <ParentLine item={current} all={issues} /> : null}
          <div className="actions" data-testid="item-actions">
            {current.status === "proposed" ? (
              <>
                <Button variant="primary" disabled={action.busy} onClick={() => void decide(current, "add")}>
                  Add
                </Button>
                <Button disabled={action.busy} onClick={() => void addAndStart(current)}>
                  Add and start a run
                </Button>
                <Button disabled={action.busy} onClick={() => void decide(current, "drop")}>
                  Drop
                </Button>
              </>
            ) : null}
            {buttons.analyse ? (
              <ItemAction button={buttons.analyse} busy={action.busy} onClick={() => void analyse(current)} />
            ) : null}
            {buttons.plan ? (
              <ItemAction button={buttons.plan} busy={action.busy} onClick={() => void makePlan(current)} />
            ) : null}
            {buttons.implement ? (
              <ItemAction
                button={buttons.implement}
                primary
                busy={action.busy}
                onClick={() => void start(current)}
              />
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
            {current.status === "open" || current.status === "in-progress" ? (
              <Button disabled={action.busy} onClick={() => finish(current, "done")}>
                Done
              </Button>
            ) : null}
            {current.status === "open" ? (
              <Button disabled={action.busy} onClick={() => finish(current, "drop")}>
                Drop
              </Button>
            ) : null}
          </div>
          {/* Why a button cannot be pressed, in words: the badge says what, this says what to do. */}
          {whyDisabled([buttons.plan, buttons.implement]).map((line) => (
            <div key={line} className="why amber" data-testid="why-disabled">
              {line}
            </div>
          ))}
          <AnalysisPart item={current} repo={repo} />
          <PlanPart item={current} repo={repo} onOpenRun={onOpenSession} />
          <ChildrenPart item={current} all={issues} onPick={setChosen} />
          <span className="spacer" />
          <div className="faint">
            An agent only proposes. A task exists after your "Add". Analyse, Make plan and Implement each
            start an agent in a terminal of its own; the plan changes only through that agent.
          </div>
        </div>
      ) : list.data === undefined ? null : (
        <div className="empty">
          <h2>No task</h2>
          <p>+ task adds one; agents' proposals appear here and in the inbox.</p>
        </div>
      )}
    </ListDetail>
  );
}
