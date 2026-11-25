/**
 * The parts of a Backlog item's page (round 17, ADR-0096): its action button, the freshness of its analysis and plan, the analysis, the plan, its children and its parent.
 */
import type { IssueView } from "../../shared/api/api.ts";
import { MarkdownBlocks } from "../../shared/components/markdown-blocks.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { routeHash } from "../../shared/model/route.ts";
import { Button } from "../../ui/button.tsx";
import { RunLink } from "../runs/run-link.tsx";
import {
  type BacklogItem,
  childRows,
  childrenProgress,
  freshnessText,
  freshnessTone,
  type ItemButton,
  itemTone,
} from "./model.ts";

/** A button of the item: disabled with its reason as its title (the reason is also a line below). */
export function ItemAction({
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
export function AnalysisPart({
  item,
  repo,
}: {
  readonly item: IssueView;
  readonly repo: string | undefined;
}) {
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
export function PlanPart({
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
export function ChildrenPart({
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
export function ParentLine({ item, all }: { readonly item: IssueView; readonly all: readonly IssueView[] }) {
  const parent = all.find((i) => i.id === item.parent);
  return (
    <div className="dim" data-testid="item-parent">
      part of{" "}
      <a href={routeHash({ screen: "backlog", id: item.parent as string })}>{parent?.title ?? item.parent}</a>
    </div>
  );
}
