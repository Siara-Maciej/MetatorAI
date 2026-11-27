/**
 * The right side of the Backlog (ADR-0113): the new-task form, or the chosen item with its
 * decision, or nothing. Each part reads the one value it draws from the Backlog store or the tasks:
 * typing a title draws the title field again, not the screen.
 */
import type { IssueView } from "../../shared/api/api.ts";
import { useDaemon, useRun } from "../../shared/daemon/daemon.tsx";
import { issueRefText } from "../../shared/model/format.ts";
import { Button } from "../../ui/button.tsx";
import { useOpenRun } from "../runs/open-run.ts";
import { RunLink } from "../runs/run-link.tsx";
import { useAllIssues, useCurrentId, useIssue, useIssues, useWorkflowOf, useWorkflows } from "./data.ts";
import { AnalysisPart, ChildrenPart, ItemAction, ParentLine, PlanPart } from "./item-parts.tsx";
import { itemButtons, pointsAt, whyDisabled } from "./model.ts";
import { NewTaskForm } from "./new-task-form.tsx";
import { useBacklog, useBacklogApi } from "./state.ts";

export function BacklogDetail() {
  const adding = useBacklog((s) => s.adding);
  const current = useCurrentId();
  const read = useIssues((issues) => issues !== undefined);
  if (adding) return <NewTaskForm />;
  if (current) return <ItemDetail id={current} />;
  return read ? (
    <div className="empty">
      <h2>No task</h2>
      <p>+ task adds one; agents' proposals appear here and in the inbox.</p>
    </div>
  ) : null;
}

/* ---------- the chosen item ---------- */

function ItemDetail({ id }: { readonly id: string }) {
  const item = useIssue(id);
  const { repo } = useDaemon("repo");
  const openRun = useOpenRun();
  if (!item) return null;
  return (
    <div className="item-detail" data-testid="item-detail">
      <ItemHead item={item} />
      <h2 title={item.title}>{item.title}</h2>
      {item.body ? <p className="text">{item.body}</p> : null}
      <div className="row">
        <span className="dim">priority</span> <span className={`pr ${item.priority}`}>{item.priority}</span>
        <span className="dim">labels</span> <span>{item.labels.join(", ") || "—"}</span>
      </div>
      <ItemLinks item={item} />
      {item.parent ? <Parent item={item} /> : null}
      <ItemActions item={item} />
      <AnalysisPart item={item} repo={repo} />
      <PlanPart item={item} repo={repo} onOpenRun={(runId) => openRun(runId)} />
      <Children item={item} />
      <span className="spacer" />
      <div className="faint">
        An agent only proposes. A task exists after your "Add". Analyse, Make plan and Implement each start an
        agent in a terminal of its own; the plan changes only through that agent.
      </div>
    </div>
  );
}

/** Its parent, read from the whole list by this line only. */
function Parent({ item }: { readonly item: IssueView }) {
  const all = useAllIssues();
  return <ParentLine item={item} all={all} />;
}

/** Its children and what each waits for; a click chooses one. */
function Children({ item }: { readonly item: IssueView }) {
  const all = useAllIssues();
  const pick = useBacklog((s) => s.pick);
  return <ChildrenPart item={item} all={all} onPick={pick} />;
}

/** Who proposed it, or its id, status and decision. */
function ItemHead({ item }: { readonly item: IssueView }) {
  const { repo } = useDaemon("repo");
  const run = useRun(item.proposedBy?.runId, repo);
  const proposing = item.proposedBy?.runId ? (run?.task ?? item.proposedBy.runId) : undefined;
  return (
    <div className="dim">
      {item.status === "proposed" && item.proposedBy
        ? `proposal · ${item.proposedBy.agent}${proposing ? ` · ${proposing}` : ""}`
        : `${item.id} · ${item.status}${item.decidedBy ? ` · ${item.decidedBy.decision} by ${item.decidedBy.by}` : ""}`}
    </div>
  );
}

/** What it points at: files as text, runs by their task (the plan's own run is under Plan). */
function ItemLinks({ item }: { readonly item: IssueView }) {
  const { repo } = useDaemon("repo");
  const openRun = useOpenRun();
  const { files, runs } = pointsAt(item);
  return (
    <>
      {files.length > 0 ? (
        <div className="dim mono">points at: {files.map(issueRefText).join(" · ")}</div>
      ) : null}
      {runs.map((r) => (
        <div key={r} className="dim">
          from: <RunLink runId={r} repo={repo} onOpen={(runId) => openRun(runId)} />
        </div>
      ))}
      {item.runId ? (
        <div className="dim">
          run: <RunLink runId={item.runId} repo={repo} onOpen={(runId) => openRun(runId)} />
        </div>
      ) : null}
    </>
  );
}

/** The decision and the buttons that start an agent; why one cannot be pressed, in words below. */
function ItemActions({ item }: { readonly item: IssueView }) {
  // The buttons depend on the item's parent and children: computed from the list, kept as they are.
  const buttons = useIssues((issues) => itemButtons(item, issues ?? [item]));
  return (
    <>
      <div className="actions" data-testid="item-actions">
        {item.status === "proposed" ? <ProposalButtons item={item} /> : null}
        {buttons.analyse ? <AgentButton item={item} button={buttons.analyse} kind="analyse" /> : null}
        {buttons.plan ? <AgentButton item={item} button={buttons.plan} kind="plan" /> : null}
        {buttons.implement ? <AgentButton item={item} button={buttons.implement} kind="implement" /> : null}
        {item.status === "proposed" || item.status === "open" ? <WorkflowPicker item={item} /> : null}
        {item.status === "open" || item.status === "in-progress" ? (
          <FinishButton item={item} how="done" />
        ) : null}
        {item.status === "open" ? <FinishButton item={item} how="drop" /> : null}
      </div>
      {whyDisabled([buttons.plan, buttons.implement]).map((line) => (
        <div key={line} className="why amber" data-testid="why-disabled">
          {line}
        </div>
      ))}
    </>
  );
}

function ProposalButtons({ item }: { readonly item: IssueView }) {
  const busy = useBacklog((s) => s.busy);
  const api = useBacklogApi();
  const workflow = useWorkflowOf(item);
  return (
    <>
      <Button variant="primary" disabled={busy} onClick={() => void api.getState().decide(item, "add")}>
        Add
      </Button>
      <Button disabled={busy} onClick={() => void api.getState().addAndStart(item, workflow)}>
        Add and start a run
      </Button>
      <Button disabled={busy} onClick={() => void api.getState().decide(item, "drop")}>
        Drop
      </Button>
    </>
  );
}

function AgentButton({
  item,
  button,
  kind,
}: {
  readonly item: IssueView;
  readonly button: NonNullable<ReturnType<typeof itemButtons>["analyse"]>;
  readonly kind: "analyse" | "plan" | "implement";
}) {
  const busy = useBacklog((s) => s.busy);
  const api = useBacklogApi();
  const workflow = useWorkflowOf(item);
  const go = () => {
    const s = api.getState();
    void (kind === "analyse"
      ? s.analyse(item)
      : kind === "plan"
        ? s.makePlan(item)
        : s.start(item, workflow));
  };
  return <ItemAction button={button} primary={kind === "implement"} busy={busy} onClick={go} />;
}

/** The workflow a run on the task starts on. */
function WorkflowPicker({ item }: { readonly item: IssueView }) {
  const workflows = useWorkflows();
  const workflow = useWorkflowOf(item);
  const want = useBacklog((s) => s.want);
  return (
    <label className="wf">
      <span className="dim">a run starts on</span>
      <select aria-label="workflow" value={workflow ?? ""} onChange={(e) => want(e.target.value)}>
        {workflows.length === 0 ? <option value="">no workflow in this repository</option> : null}
        {workflows.map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Done and Drop: asked first, the app cannot reopen the task. */
function FinishButton({ item, how }: { readonly item: IssueView; readonly how: "done" | "drop" }) {
  const busy = useBacklog((s) => s.busy);
  const finish = useBacklog((s) => s.finish);
  return (
    <Button disabled={busy} onClick={() => void finish(item, how)}>
      {how === "done" ? "Done" : "Drop"}
    </Button>
  );
}
