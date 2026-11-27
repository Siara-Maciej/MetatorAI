/**
 * What the Backlog reads from the daemon (ADR-0113): one request per kind, each part of the screen
 * taking from it only what it draws, so a part draws again only when its own piece changed.
 */
import type { IssueView } from "../../shared/api/api.ts";
import { useDaemon, usePolledSelect, useRun } from "../../shared/daemon/daemon.tsx";
import { workflowChoice } from "../../shared/model/runs.ts";
import { backlogRows } from "./model.ts";
import { issuesKey, useBacklog } from "./state.ts";

const NO_ISSUES: readonly IssueView[] = [];
const NO_WORKFLOWS: readonly string[] = [];

/** Every task of the shown repository, or `select`'s part of them (undefined before the first answer). */
export function useIssues<R>(select: (issues: readonly IssueView[] | undefined) => R): R {
  const { client, repo } = useDaemon("client", "repo");
  return usePolledSelect(
    issuesKey(repo),
    () => client.issues(repo),
    2000,
    (d) => select(d?.issues),
  );
}

/** The whole list (empty before the first answer): for parts that need every task (a parent, children). */
export const useAllIssues = (): readonly IssueView[] => useIssues((issues) => issues ?? NO_ISSUES);

/** One task by its id. */
export const useIssue = (id: string | undefined): IssueView | undefined =>
  useIssues((issues) => issues?.find((i) => i.id === id));

/** The ids of the list, a parent's children right under it; the finished ones apart. */
export function useRowIds() {
  return useIssues((issues) => {
    const rows = backlogRows(issues ?? NO_ISSUES);
    const ids = (part: typeof rows.open) => part.map((r) => ({ id: r.item.id, child: r.child }));
    return { proposals: ids(rows.proposals), open: ids(rows.open), finished: ids(rows.finished) };
  });
}

/** The id the person (or the route) chose, if any. */
const explicitOf = (s: { readonly picked: string | undefined; readonly routeId: string | undefined }) =>
  s.picked ?? s.routeId;

/** The first proposal, else the first open task: shown when nothing (known) is chosen. */
function firstOf(issues: readonly IssueView[] | undefined): string | undefined {
  const rows = backlogRows(issues ?? NO_ISSUES);
  return rows.proposals.find((r) => !r.child)?.item.id ?? rows.open.find((r) => !r.child)?.item.id;
}

/**
 * The id of the item shown on the right: the one picked, else the route's, else the first proposal,
 * else the first open task. A chosen id the list does not have falls back the same way.
 */
export function useCurrentId(): string | undefined {
  const explicit = useBacklog(explicitOf);
  return useIssues((issues) =>
    explicit !== undefined && issues?.some((i) => i.id === explicit) ? explicit : firstOf(issues),
  );
}

/**
 * Whether `id` is the item shown on the right, for a row: a row hears only of its own yes or no,
 * so choosing another item draws two rows again; only the first row, which is the fallback, follows
 * every choice.
 */
export function useIsCurrent(id: string): boolean {
  const mine = useBacklog((s) => explicitOf(s) === id);
  const first = useIssues((issues) => firstOf(issues) === id);
  const explicit = useBacklog((s) => (first ? explicitOf(s) : undefined));
  const known = useIssues(
    (issues) => explicit !== undefined && issues?.some((i) => i.id === explicit) === true,
  );
  return mine || (first && (explicit === undefined || !known));
}

/**
 * The workflows this repository has (D5): a run starts on one of them, never on a guess. Undefined
 * until the daemon answered, so "none" is said only on its word.
 */
export function useKnownWorkflows(): readonly string[] | undefined {
  const { client, repo } = useDaemon("client", "repo");
  return usePolledSelect(
    `workflows:${repo ?? ""}`,
    () => client.workflows(repo),
    30_000,
    (d) => d?.workflows.map((w) => w.id),
  );
}

/** The workflows, empty while they are read. */
const useWorkflows = (): readonly string[] => useKnownWorkflows() ?? NO_WORKFLOWS;

/** The workflow a run on the task starts with: the chosen one, else the proposing run's, else the default. */
export function useWorkflowOf(issue: IssueView | undefined): string | undefined {
  const workflows = useWorkflows();
  const wanted = useBacklog((s) => s.wanted);
  const { repo } = useDaemon("repo");
  const proposing = useRun(issue?.proposedBy?.runId, repo)?.workflow;
  return workflowChoice(workflows, wanted ?? proposing);
}
