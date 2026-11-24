/**
 * The backlog (S4, design/13 §4, mockup "Backlog"): proposals that wait for your decision and the
 * open tasks in one list, a parent's children right under it; the chosen one on the right with its
 * text, its analysis and its plan (each with a freshness badge), its children and what each waits
 * for, and the decision. An agent only proposes; the task exists after your "Add". Analyse, Make
 * plan and Implement each start an agent in a terminal of its own, and the app shows it (round 17).
 */

import { useEffect, useMemo, useState } from "react";
import type { Issue, IssueView, PlanStarted } from "../../shared/api/api.ts";
import { Glyph } from "../../shared/components/glyph.tsx";
import { MarkdownBlocks } from "../../shared/components/markdown-blocks.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { type Answer, useAction } from "../../shared/hooks.ts";
import { duration, issueRefText, plural } from "../../shared/model/format.ts";
import { routeHash } from "../../shared/model/route.ts";
import { workflowChoice } from "../../shared/model/runs.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { refusedForDirtyTree, START_FROM_COMMIT } from "../runs/model.ts";
import { useOpenRun } from "../runs/open-run.ts";
import { RunLink } from "../runs/run-link.tsx";
import { dropBacklogDraft, useBacklogDraft } from "./draft.ts";
import {
  type BacklogItem,
  backlogRows,
  childRows,
  childrenProgress,
  freshnessText,
  freshnessTone,
  type ItemButton,
  itemButtons,
  itemTone,
  itemWord,
  type ListRowOf,
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
          {open.length === 0 && proposals.length === 0 ? (
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
                <Button variant="primary" onClick={() => void decide(current, "add")}>
                  Add
                </Button>
                <Button onClick={() => void addAndStart(current)}>Add and start a run</Button>
                <Button onClick={() => void decide(current, "drop")}>Drop</Button>
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
              <Button onClick={() => act((by) => client.closeIssue(current.id, by, repo))}>Done</Button>
            ) : null}
            {current.status === "open" ? (
              <Button onClick={() => act((by) => client.dropIssue(current.id, by, repo))}>Drop</Button>
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
      ) : (
        <div className="empty">
          <h2>No task</h2>
          <p>+ task adds one; agents' proposals appear here and in the inbox.</p>
        </div>
      )}
    </ListDetail>
  );
}

/** A button of the item: disabled with its reason as its title (the reason is also a line below). */
function ItemAction({
  button,
  primary = false,
  busy,
  onClick,
}: {
  readonly button: ItemButton;
  readonly primary?: boolean;
  readonly busy: boolean;
  onClick(): void;
}) {
  return (
    <Button
      className={primary ? "primary" : undefined}
      disabled={button.disabled !== undefined || busy}
      title={button.disabled}
      onClick={onClick}
    >
      {button.label}
    </Button>
  );
}

/** A badge of freshness: one word, or the files that changed. */
function FreshnessBadge({ item, of }: { readonly item: BacklogItem; readonly of: "analysis" | "plan" }) {
  const f = item.freshness?.[of];
  if (!f) return null;
  return (
    <span
      className={`chip ${freshnessTone(f)}`}
      data-testid={`${of}-freshness`}
      title={f.state === "stale" ? f.changed.join("\n") : undefined}
    >
      {freshnessText(f)}
    </span>
  );
}

/** The item's detail (`GET /issues/:id`): its analysis text and its plan in short, read when they change. */
function useIssueDetail(item: IssueView, repo: string | undefined) {
  const { client } = useDaemon("client");
  return usePolled(
    `issue-detail:${repo ?? ""}:${item.id}:${item.analysis?.at ?? ""}:${item.plan?.at ?? ""}`,
    () => (item.analysis || item.plan ? client.issue(item.id, repo) : Promise.resolve({ ok: true })),
    0,
  );
}

/** The item's analysis, rendered, with its badge; or how to get one. */
function AnalysisPart({ item, repo }: { readonly item: IssueView; readonly repo: string | undefined }) {
  const detail = useIssueDetail(item, repo);
  if (!item.analysis)
    return item.status === "open" ? (
      <section className="item-part" aria-label="analysis" data-testid="item-analysis">
        <h3>Analysis</h3>
        <div className="faint">None yet: Analyse asks an agent to read the code for this task.</div>
      </section>
    ) : null;
  const text = detail.data?.analysisText;
  return (
    <section className="item-part" aria-label="analysis" data-testid="item-analysis">
      <h3>
        Analysis <FreshnessBadge item={item} of="analysis" />
      </h3>
      <div className="prose-box">
        {text !== undefined ? (
          <MarkdownBlocks text={text} />
        ) : (
          <div className="faint">{detail.error ?? "Reading the analysis…"}</div>
        )}
      </div>
    </section>
  );
}

/** The item's plan: its badge, what it holds in short, and the run that made it. */
function PlanPart({
  item,
  repo,
  onOpenRun,
}: {
  readonly item: IssueView;
  readonly repo: string | undefined;
  onOpenRun(runId: string): void;
}) {
  const detail = useIssueDetail(item, repo);
  const plan = item.plan;
  if (!plan) return null;
  // A parent made from the plan has the plan's summary as its text already: said once.
  const said = detail.data?.planSummary;
  const summary = said !== undefined && said.trim() !== item.body.trim() ? said : undefined;
  return (
    <section className="item-part" aria-label="plan" data-testid="item-plan">
      <h3>
        {plan.kind === "system-plan" ? "System plan" : "Plan"} <FreshnessBadge item={item} of="plan" />
        <span className="spacer" />
        <span className="dim">its run</span> <RunLink runId={plan.runId} repo={repo} onOpen={onOpenRun} />
      </h3>
      {summary ? (
        <div className="prose-box plan-summary">
          <MarkdownBlocks text={summary} />
        </div>
      ) : null}
    </section>
  );
}

/** A parent's children: one word each and what each waits for; the parent says how many are done. */
function ChildrenPart({
  item,
  all,
  onPick,
}: {
  readonly item: IssueView;
  readonly all: readonly IssueView[];
  onPick(id: string): void;
}) {
  const rows = childRows(item, all);
  if (rows.length === 0) return null;
  return (
    <section className="item-part" aria-label="parts" data-testid="item-children">
      <h3>
        Parts <span className="faint">· {childrenProgress(item, all)}</span>
      </h3>
      <ul className="item-children">
        {rows.map((c) => (
          <li key={c.id} data-testid={`child-${c.id}`}>
            <Button variant="ghost" onClick={() => onPick(c.id)}>
              {c.title}
            </Button>
            <span className={`word ${itemTone(c.word)}`}>{c.word}</span>
            {c.waits ? <span className="faint">{c.waits}</span> : null}
          </li>
        ))}
      </ul>
      <div className="faint">The parent is done by itself once every part is done or dropped.</div>
    </section>
  );
}

/** A child names its parent, a link to it. */
function ParentLine({ item, all }: { readonly item: IssueView; readonly all: readonly IssueView[] }) {
  const parent = all.find((i) => i.id === item.parent);
  return (
    <div className="dim" data-testid="item-parent">
      part of{" "}
      <a href={routeHash({ screen: "backlog", id: item.parent as string })}>{parent?.title ?? item.parent}</a>
    </div>
  );
}
