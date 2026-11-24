import type { PaneChange } from "@metator/core";
import { type TopicName, topic } from "./events.ts";

/**
 * What a request that is not a GET may have changed, by its route's pattern (ADR-0110): the first
 * row whose pattern fits names the topics. A route no row names publishes `UNKNOWN_ROUTE`: a new
 * route is announced broadly until it gets its own row (`test/serve-events.test.ts` lists them).
 */
interface Row {
  /** Matched against the route's pattern (`/runs/:run/answer`), not the request's path. */
  readonly pattern: RegExp;
  readonly topics: readonly TopicName[];
}

/** What a route no row names publishes. */
export const UNKNOWN_ROUTE: readonly TopicName[] = ["state", "inbox", "layout"];

/** A run's work: what it shows, its questions, its panes and its activity. */
const RUN: readonly TopicName[] = ["state", "inbox", "layout", "activity"];

export const ROUTE_TOPICS: readonly Row[] = [
  // Runs. A run's plan lint changes the plan's findings; the rest is the run's work.
  { pattern: /^\/runs$/, topics: ["state", "inbox", "layout"] },
  { pattern: /^\/runs\/:run\/plan\/lint$/, topics: ["plans", "state"] },
  { pattern: /^\/runs\/:run\//, topics: RUN },
  // Terminals (ADR-0080): a pane's answer or a run it started is also the inbox and the state.
  { pattern: /^\/panes\/:pane\/(answer|started-run)$/, topics: ["layout", "inbox", "state"] },
  { pattern: /^\/(panes|tabs|workspaces)(\/|$)/, topics: ["layout"] },
  // Threads (ADR-0095): their tree, their chat panes and the threads mark of the state.
  { pattern: /^\/threads(\/|$)/, topics: ["threads", "layout", "state"] },
  { pattern: /^\/options\//, topics: ["options"] },
  // The Backlog (ADR-0096): analyse, plan and start open panes and runs.
  { pattern: /^\/issues\/:issue\/(analyze|plan|start)$/, topics: ["backlog", "state", "inbox", "layout"] },
  { pattern: /^\/issues(\/|$)/, topics: ["backlog"] },
  // System plans and the map they are made from (ADR-0087).
  { pattern: /^\/system\//, topics: ["plans", "state", "inbox"] },
  // Reviews (ADR-0097): a review opens a run and its conductor.
  { pattern: /^\/(reviews|mrs)(\/|$)/, topics: ["reviews", "inbox", "state", "layout"] },
  // Debug changes (ADR-0093): the state counts them.
  { pattern: /^\/scratch\//, topics: ["state"] },
];

/**
 * The topics a request that is not a GET publishes once answered: its route's row, with the run
 * of `activity` from the route's `:run`, and the repository a repo-scoped topic carries in a folder.
 */
export function routeTopics(
  pattern: string,
  params: Readonly<Record<string, string>>,
  repo?: string,
): string[] {
  const names = ROUTE_TOPICS.find((r) => r.pattern.test(pattern))?.topics ?? UNKNOWN_ROUTE;
  return names.flatMap((name) => {
    if (name !== "activity") return [topic(name, repo ? { repo } : {})];
    const runId = params.run;
    return runId ? [topic("activity", { runId, ...(repo ? { repo } : {}) })] : [];
  });
}

/**
 * What a pane's change is news of: the layout always; a run's pane also changes what the state
 * says of the run (its agent working, idle, gone) and its activity (an exit or idleness is noted there).
 */
export function paneTopics(change: PaneChange, repo?: string): string[] {
  const at = repo ? { repo } : {};
  const layout = topic("layout", at);
  if (!change.runId) return [layout];
  return [layout, topic("state"), topic("activity", { runId: change.runId, ...at })];
}
