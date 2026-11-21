import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAEMON_FILE,
  DaemonInfoDocument,
  err,
  fleetInbox,
  MetatorError,
  type Overview,
  ok,
  type Question,
  type RepoRuns,
  type Result,
  serializeJsonDocument,
  withNeedsText,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { ServerWebSocket } from "bun";
import type { CommandContext } from "../context.ts";
import { liveDaemonAt } from "../daemon-client.ts";
import { CORS, type Daemon, dispatcher, json, type Route } from "./http.ts";
import { ARTIFACT_ROUTES } from "./routes/artifacts.ts";
import { BACKLOG_ROUTES } from "./routes/backlog.ts";
import { OVERVIEW_ROUTES } from "./routes/overview.ts";
import { PANE_ROUTES } from "./routes/panes.ts";
import { PLAN_ROUTES } from "./routes/plans.ts";
import { RUN_ROUTES } from "./routes/runs.ts";
import { SCRATCH_ROUTES } from "./routes/scratch.ts";
import { SESSION_ROUTES } from "./routes/sessions.ts";
import { SYSTEM_ROUTES } from "./routes/system.ts";
import { type Socket, socketHandlers, upgrade } from "./sockets.ts";
import { startTimers } from "./timers.ts";

/** Every route of the daemon, by resource; the first that fits a request answers it. */
export const ROUTES: readonly Route[] = [
  ...OVERVIEW_ROUTES,
  ...BACKLOG_ROUTES,
  ...SESSION_ROUTES,
  ...PANE_ROUTES,
  ...SCRATCH_ROUTES,
  ...RUN_ROUTES,
  ...PLAN_ROUTES,
  ...SYSTEM_ROUTES,
  ...ARTIFACT_ROUTES,
];

/** What a browser or the desktop app gets from the daemon (D3, ADR-0077). */
export interface ServeOptions {
  readonly port: number;
  readonly hostname: string;
  /** How often the state and activity sockets look for a change. */
  readonly pollMs?: number;
  /** Say where the daemon listens on stderr as soon as it does (`{"serving": {url, …}}`). */
  readonly announce?: boolean;
  /** Run the supervisor's tick this often (0: not at all). */
  readonly superviseMs?: number;
  /** Scan the intake rules this often (0 or unset: never); the config's `intake.everyMs` when `true`. */
  readonly intakeMs?: number | true;
  /** Look for reviews of my requests this often (0 or unset: never); the config's `everyMs` when `true`. */
  readonly reviewsMs?: number | true;
  /** false (`--no-restore`): sessions that went with the last daemon stay paused until continued. */
  readonly restore?: boolean;
  /** How often every live pane's screen is kept on disk (default 5 s; 0: only when it stops). */
  readonly screensMs?: number;
  /** How the supervisor starts a drive again. */
  readonly restart?: (
    c: MetatorContainer,
    runId: string,
  ) => Promise<Result<{ readonly stage: string }, MetatorError>>;
}

export interface Served {
  readonly port: number;
  readonly hostname: string;
  readonly pid: number;
  stop(): Promise<void>;
}

/**
 * `metator serve`: the local daemon the desktop app talks to. Every endpoint runs the same use
 * cases as the CLI; the daemon keeps nothing that is not on disk, except the PTY sessions it brokers.
 * Localhost only, no authentication (decision 1).
 */
/** The directories a daemon started here serves: the repository, or each repository of the folder. */
export function servedRoots(ctx: CommandContext): string[] {
  const folder = ctx.folder();
  return folder ? folder.repos.map((r) => r.root) : [ctx.container().resolve("root")];
}

/**
 * Another daemon that already serves one of these directories (R7): a second one would write its
 * own address over the first one's file, and the CLI and the app would talk to the wrong process.
 */
export function daemonInTheWay(roots: readonly string[]): MetatorError | undefined {
  for (const root of roots) {
    const other = liveDaemonAt(root);
    if (other && other.pid !== process.pid)
      return MetatorError.usage(
        `a daemon already serves ${root}: ${other.url} (pid ${other.pid})`,
        `Use that one, or stop it first (kill ${other.pid}). A daemon for another repository is fine: run \`metator serve --port <other>\` there.`,
      );
  }
  return undefined;
}

export async function startServer(ctx: CommandContext, opts: ServeOptions): Promise<Served> {
  const folder = ctx.folder();
  const pollMs = opts.pollMs ?? 1000;
  const started = Date.now();
  const sockets = new Set<ServerWebSocket<Socket>>();

  // One container per repository for the daemon's lifetime: the PTY broker lives in it.
  const containers = new Map<string, MetatorContainer>();
  const cached = (key: string, make: () => MetatorContainer): MetatorContainer => {
    const c = containers.get(key) ?? make();
    containers.set(key, c);
    return c;
  };
  const containerFor = (
    repo: string | undefined,
  ): Result<MetatorContainer, { code: string; message: string }> => {
    if (!folder) return ok(cached(".", () => ctx.container()));
    // A repository by its name in the folder, or by its root (what a command run inside it knows).
    const entry = repo ? folder.repos.find((r) => r.name === repo || r.root === repo) : folder.repos[0];
    if (!entry)
      return err({ code: "NOT_FOUND", message: `repository ${repo ?? "(none)"} is not in ${folder.root}` });
    return ok(cached(entry.root, () => ctx.containerAt(entry.root)));
  };

  // One overview per repository per tick (R12): every socket of a tick reads the same one, and a
  // request that changes something makes the next reader look again.
  const overviews = new Map<string, { at: number; value: Promise<Result<Overview, MetatorError>> }>();
  const overviewOf = (key: string, c: MetatorContainer, fresh: boolean) => {
    const held = overviews.get(key);
    if (!fresh && held && Date.now() - held.at < pollMs / 2) return held.value;
    const value = c.resolve("workOverview").execute();
    overviews.set(key, { at: Date.now(), value });
    return value;
  };
  const repoViews = (): { name: string; path: string; key: string; c: MetatorContainer }[] =>
    folder
      ? folder.repos.map((r) => ({
          name: r.name,
          path: r.path,
          key: r.root,
          c: cached(r.root, () => ctx.containerAt(r.root)),
        }))
      : [{ name: "", path: ".", key: ".", c: cached(".", () => ctx.container()) }];
  /**
   * A served overview: each question's options say which ones ask for the person's own words
   * (`needsText`), so the app reads the rule as data instead of keeping its own.
   */
  const served = async (
    o: Overview,
    c: MetatorContainer,
  ): Promise<Overview & { readonly scratch: number }> => {
    // A run whose agent asked the person in words (a pane question) needs them, as a card would.
    const asking = new Set(
      c
        .resolve("paneQuestions")
        .open()
        .flatMap((q) => (q.runId ? [q.runId] : [])),
    );
    return {
      ...o,
      // Debug changes (ADR-0093): how many scratch records the repository holds; the list is `/scratch`.
      scratch: await c.resolve("scratch").count(),
      runs: await Promise.all(
        o.runs.map(async (r) => ({
          ...r,
          ...(asking.has(r.runId) && r.status === "active" ? { attention: "you" as const } : {}),
          questions: await Promise.all(r.questions.map((q) => approvable(withNeedsText(q), c))),
        })),
      ),
    };
  };
  /**
   * A gate question whose Approve the gate refuses now (a system plan with lint errors): its
   * Approve option says so (`disabled`, `disabledBecause`), so the card can show why.
   */
  const approvable = async <Q extends Question>(q: Q, c: MetatorContainer): Promise<Q> => {
    if (q.source !== "gate" || q.answer) return q;
    const refused = await c.resolve("gateApprovals").refusal(q.runId, q.stage);
    if (refused.isErr() || !refused.value) return q;
    const because = refused.value.message;
    return {
      ...q,
      options: q.options.map((o) =>
        o.label === "Approve" ? { ...o, disabled: true, disabledBecause: because } : o,
      ),
    };
  };
  /** The same overview `metator status` prints: one repository, or each repository of a folder. */
  const state = async (fresh: boolean): Promise<Result<unknown, MetatorError>> => {
    const views = repoViews();
    if (!folder) {
      const only = views[0] as (typeof views)[number];
      const o = await overviewOf(only.key, only.c, fresh);
      // The state says what is wrong in two words: the code and the message.
      if (o.isErr()) return err(new MetatorError(o.error.code, o.error.message));
      return ok(await served(o.value, only.c));
    }
    const repos: Record<string, unknown>[] = [];
    for (const r of views) {
      const o = await overviewOf(r.key, r.c, fresh);
      repos.push({
        name: r.name,
        path: r.path,
        ...(o.isOk() ? await served(o.value, r.c) : { error: o.error.message }),
      });
    }
    return ok({ folder: folder.root, repos });
  };
  /**
   * The questions of panes without a run (ADR-0091), oldest first: the intake chat whose host asks
   * leave to run a command. Each names its pane (its label and role) and, in a folder, its
   * repository; answered with `POST /panes/:pane/answer`.
   */
  const paneAsks = async () => {
    const out: Record<string, unknown>[] = [];
    for (const r of repoViews()) {
      for (const question of r.c.resolve("paneQuestions").open()) {
        const pane = await r.c.resolve("panes").pane(question.paneId);
        out.push({
          kind: "pane",
          ...(folder ? { repo: r.name } : {}),
          paneId: question.paneId,
          ...(question.runId ? { runId: question.runId } : {}),
          label: pane.isOk() ? pane.value.label : question.agent,
          ...(pane.isOk() ? { role: pane.value.role } : {}),
          host: question.host,
          question,
        });
      }
    }
    return out.sort((a, b) =>
      String((a.question as { askedAt: string }).askedAt).localeCompare(
        String((b.question as { askedAt: string }).askedAt),
      ),
    );
  };
  /** The same queue `metator inbox` prints. */
  const inbox = async (fresh: boolean): Promise<Result<unknown, MetatorError>> => {
    const repos: RepoRuns[] = [];
    for (const r of repoViews()) {
      const o = await overviewOf(r.key, r.c, fresh);
      if (o.isErr()) continue;
      repos.push({ name: r.name, runs: (await served(o.value, r.c)).runs, now: r.c.resolve("clock").now() });
    }
    const queue = fleetInbox(repos, folder !== null);
    return ok({
      decisions: queue.decisions,
      escalated: queue.escalated,
      panes: await paneAsks(),
    });
  };

  let bound = opts.port;
  const daemon: Daemon = {
    folder,
    startedAt: started,
    hostname: opts.hostname,
    superviseMs: opts.superviseMs ?? 0,
    port: () => bound,
    state,
    inbox,
    repos: () => repoViews().map((r) => (folder ? { name: r.name, c: r.c } : { c: r.c })),
  };
  /** The repository whose panes know this token: a call from a pane acts in its own repository. */
  const repoOfToken = async (token: string): Promise<string | undefined> => {
    if (!folder) return undefined;
    for (const r of folder.repos) {
      const pane = await cached(r.root, () => ctx.containerAt(r.root))
        .resolve("panes")
        .authorize(token);
      if (pane) return r.name;
    }
    return undefined;
  };
  // Bun ends a request that sends nothing for 10 s; a long poll waits as long as it was asked to.
  let listening: { timeout(req: Request, seconds: number): void } | undefined;
  const dispatch = dispatcher(ROUTES, {
    daemon,
    containerFor,
    repoOfToken,
    untimed: (req) => listening?.timeout(req, 0),
  });

  const server = Bun.serve<Socket>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const path = url.pathname.replace(/\/+$/, "") || "/";
      // A request that may change a run: the sockets' next tick reads the runs again.
      if (req.method !== "GET") overviews.clear();
      // The daemon's own pulse: not an envelope, so a probe reads it without knowing MetatorAI.
      if (path === "/health")
        return json({
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - started,
          folder: folder?.root ?? null,
        });
      const socket = upgrade(req, server, url, path);
      if (socket) return socket.upgraded ? undefined : json({ ok: false }, 400);
      return dispatch(req, url, path);
    },
    websocket: socketHandlers({ pollMs, containerFor, state, inbox }, sockets),
  });
  listening = server;
  bound = server.port ?? opts.port;
  const timers = startTimers({
    repos: () => (folder ? folder.repos.map((r) => r.name) : [undefined]),
    containerFor,
    superviseMs: opts.superviseMs ?? 0,
    // Each repository's own interval unless one is given: in a folder each keeps its own.
    intakeMs: opts.intakeMs === true ? "own" : (opts.intakeMs ?? 0),
    reviewsMs: opts.reviewsMs === true ? "own" : (opts.reviewsMs ?? 0),
    sweepMs: Math.max(1000, pollMs * 2),
    screensMs: opts.screensMs ?? 5000,
    ...(opts.restart ? { restart: opts.restart } : {}),
  });
  const port = bound;
  // Where the daemon listens, for the CLI and the clients; and every pane of the layout back.
  const roots = servedRoots(ctx);
  const info = serializeJsonDocument(
    DaemonInfoDocument.stamp({
      url: `http://${opts.hostname}:${port}`,
      pid: process.pid,
      startedAt: new Date(started).toISOString(),
    }),
  );
  for (const root of roots) {
    mkdirSync(join(root, ".metator"), { recursive: true });
    writeFileSync(join(root, DAEMON_FILE), info);
  }
  const restored: { root: string; paneId: string; ok: boolean; error?: string }[] = [];
  for (const root of roots) {
    const c = folder
      ? containerFor(folder.repos.find((r) => r.root === root)?.name)
      : containerFor(undefined);
    if (c.isErr()) continue;
    const r = await c.value.resolve("panes").restore(undefined, { resume: opts.restore !== false });
    if (r.isOk()) restored.push(...r.value.map((x) => ({ root, ...x })));
  }
  if (opts.announce) {
    const serving = {
      port,
      hostname: opts.hostname,
      pid: process.pid,
      url: `http://${opts.hostname}:${port}`,
      restored,
    };
    process.stderr.write(`${JSON.stringify({ serving })}\n`);
  }
  return {
    port,
    hostname: opts.hostname,
    pid: process.pid,
    stop: async () => {
      timers.stop();
      // The sessions go with the daemon: paused, their screens kept, to be resumed next time.
      for (const key of containers.keys()) {
        const paused = await (containers.get(key) as MetatorContainer).resolve("panes").pauseAll();
        if (paused.isErr())
          process.stderr.write(`${JSON.stringify({ panes: { repo: key, error: paused.error.message } })}\n`);
      }
      // Only its own file: one another daemon wrote since says where that daemon listens.
      for (const root of roots) {
        const file = join(root, DAEMON_FILE);
        if (existsSync(file) && readFileSync(file, "utf8") === info) rmSync(file, { force: true });
      }
      for (const ws of sockets) ws.close();
      await server.stop(true);
    },
  };
}
