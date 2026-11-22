import { byUrgency, type EscalatedItem, escalatedOf, type InboxItem, inboxOf } from "./inbox.ts";

/**
 * Several repositories seen as one (a folder of repositories, G2): the same queue and the same
 * counts as within one repository, each item named with the repository it belongs to. Every front
 * (the terminal, the daemon) reads its repositories and hands them here.
 */

type InboxRuns = Parameters<typeof inboxOf>[0];
type EscalatedRuns = Parameters<typeof escalatedOf>[0];

export interface RepoRuns {
  /** The repository's name; left out of the items when there is only the one repository. */
  readonly name: string;
  readonly runs: readonly (InboxRuns[number] & EscalatedRuns[number])[];
  /** The repository's own clock: how long each question has waited is counted from it. */
  readonly now: Date;
}

export interface FleetInbox {
  readonly decisions: readonly (InboxItem & { readonly repo?: string })[];
  readonly escalated: readonly (EscalatedItem & { readonly repo?: string })[];
}

/**
 * One queue across repositories, in the same order as within one: first what a live drive waits
 * on, then what has waited longest; then the escalated runs. `named` puts the repository on each
 * item (a folder); a single repository's items carry none.
 */
export function fleetInbox(repos: readonly RepoRuns[], named: boolean): FleetInbox {
  const decisions: (InboxItem & { repo?: string })[] = [];
  const escalated: (EscalatedItem & { repo?: string })[] = [];
  for (const r of repos) {
    for (const item of inboxOf(r.runs, r.now)) decisions.push(named ? { repo: r.name, ...item } : item);
    for (const item of escalatedOf(r.runs, r.now)) escalated.push(named ? { repo: r.name, ...item } : item);
  }
  return { decisions: decisions.sort(byUrgency), escalated };
}

/** The keys of the counts a folder adds up over its repositories. */
export const FLEET_COUNTS = ["you", "driving", "stopped", "questions", "services"] as const;
export type FleetCounts = Readonly<Record<(typeof FLEET_COUNTS)[number], number>>;

/** The folder's counts: each repository's own, added up; a repository that could not be read adds nothing. */
export function fleetCounts(repos: readonly object[]): FleetCounts {
  const of = (r: object) =>
    ("counts" in r ? r.counts : undefined) as Readonly<Record<string, number | undefined>> | undefined;
  const sum = (k: (typeof FLEET_COUNTS)[number]) => repos.reduce((n, r) => n + (of(r)?.[k] ?? 0), 0);
  return {
    you: sum("you"),
    driving: sum("driving"),
    stopped: sum("stopped"),
    questions: sum("questions"),
    services: sum("services"),
  };
}
