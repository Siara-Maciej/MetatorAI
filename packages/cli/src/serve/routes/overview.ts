import { acceptanceStats, type MetatorError, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Daemon, Route } from "../http.ts";
import { route } from "../http.ts";

/** What the daemon reads for every screen: its health, the state, the inbox, the supervisor's view. */

/**
 * What the Supervisor screen shows: the daemon, its hosts and policy, the live PTY sessions,
 * and the acceptance figures (11a, 11b) from the same facts as `metator report`.
 */
async function supervisorView(
  c: MetatorContainer,
  repo: string | undefined,
  daemon: Pick<Daemon, "folder" | "startedAt" | "hostname" | "superviseMs" | "port">,
): Promise<Result<unknown, MetatorError>> {
  const policy = c.resolve("config").config.supervisor;
  const facts = await c.resolve("buildReport").facts();
  if (facts.isErr()) return facts;
  const journal = c.resolve("runJournal");
  const runs: Parameters<typeof acceptanceStats>[0][number][] = [];
  for (const f of facts.value) {
    const a = await journal.activity(f.runId);
    runs.push({ questions: f.questions, activity: a.isOk() ? [...a.value] : [] });
  }
  const chatAgent = await c.resolve("chatAgent")();
  const dayAgo = new Date(c.resolve("clock").now().getTime() - 24 * 3600 * 1000).toISOString();
  return ok({
    daemon: {
      pid: process.pid,
      uptimeMs: Date.now() - daemon.startedAt,
      url: `http://${daemon.hostname}:${daemon.port()}`,
      superviseMs: daemon.superviseMs,
      folder: daemon.folder?.root ?? null,
      repo: repo ?? null,
    },
    hosts: [...c.resolve("interactiveHosts").keys()],
    // Which of them can start on this machine: the app offers only those (D1).
    hostStatus: c.resolve("hostStatus")(),
    policy,
    // The agent the "+ New run" chat opens: the conversation agent where the repository has it.
    ...(chatAgent ? { chatAgent } : {}),
    sessions: c.resolve("ptyBroker").list(),
    acceptance: { since: dayAgo, ...acceptanceStats(runs, dayAgo) },
  });
}

export const OVERVIEW_ROUTES: readonly Route[] = [
  route({ method: "GET", pattern: "/state", global: true, handler: ({ daemon }) => daemon.state(true) }),
  route({ method: "GET", pattern: "/inbox", global: true, handler: ({ daemon }) => daemon.inbox(true) }),
  route({
    method: "GET",
    pattern: "/conflicts",
    handler: ({ c }) => c.resolve("worktreeConflicts").execute({}),
  }),
  route({
    method: "GET",
    pattern: "/workflows",
    handler: async ({ c }) => {
      const scan = await c.resolve("workflowCatalog").scan();
      return ok({
        workflows: scan.workflows.map(({ spec, source }) => ({
          id: spec.id,
          revision: spec.revision,
          ...(spec.description ? { description: spec.description } : {}),
          // The levels the workflow runs at: the form offers only these.
          ...(spec.autonomy ? { autonomy: spec.autonomy } : {}),
          stages: spec.stages.map((st) => st.id),
          source,
        })),
      });
    },
  }),
  route({
    method: "GET",
    pattern: "/report",
    handler: ({ c, query }) => c.resolve("buildReport").execute(query.get("since") ?? undefined),
  }),
  route({
    method: "GET",
    pattern: "/supervisor",
    handler: ({ c, repo, daemon }) => supervisorView(c, repo, daemon),
  }),
];
