import {
  acceptanceStats,
  briefOf,
  byUrgency,
  type InboxItem,
  inboxOf,
  type MetatorError,
  type PtyEvent,
  type Result,
  type Supervisor,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { CommandContext, Folder } from "../context.ts";

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
  /** How the supervisor starts a drive again. */
  readonly restart?: (
    c: MetatorContainer,
    runId: string,
  ) => Promise<Result<{ readonly stage: string }, MetatorError>>;
  /** How a run created from the app is driven at once (`POST /runs` with `drive`), on the given host. */
  readonly start?: (
    c: MetatorContainer,
    runId: string,
    host: string,
  ) => Promise<Result<{ readonly stage: string; readonly started: boolean }, MetatorError>>;
}

export interface Served {
  readonly port: number;
  readonly hostname: string;
  readonly pid: number;
  stop(): Promise<void>;
}

type Json = Record<string, unknown>;

interface Socket {
  readonly kind: "state" | "inbox" | "activity" | "pty";
  readonly repo: string | undefined;
  readonly runId?: string | undefined;
  readonly by?: string | undefined;
  stop?: () => void;
}

/**
 * The app is another origin (Tauri's webview, or a browser next to the daemon), so every answer
 * says any origin may read it: the daemon listens on localhost only and has no secrets to guard
 * beyond what every local process can read anyway (decision 1).
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const fromResult = <T>(r: Result<T, MetatorError>) =>
  r.isOk()
    ? json({ ok: true, data: r.value })
    : json({ ok: false, error: { code: r.error.code, message: r.error.message, hint: r.error.hint } }, 400);

/**
 * `metator serve`: the local daemon the desktop app talks to. Every endpoint runs the same use
 * cases as the CLI; the daemon keeps nothing that is not on disk, except the PTY sessions it brokers.
 * Localhost only, no authentication (decision 1).
 */
export async function startServer(ctx: CommandContext, opts: ServeOptions): Promise<Served> {
  const folder = ctx.folder();
  const pollMs = opts.pollMs ?? 1000;
  const started = Date.now();
  const sockets = new Set<import("bun").ServerWebSocket<Socket>>();

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
    const entry = repo ? folder.repos.find((r) => r.name === repo) : folder.repos[0];
    if (!entry)
      return err({ code: "NOT_FOUND", message: `repository ${repo ?? "(none)"} is not in ${folder.root}` });
    return ok(cached(entry.root, () => ctx.containerAt(entry.root)));
  };

  const server = Bun.serve<Socket>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const repo = url.searchParams.get("repo") ?? undefined;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/health")
        return json({
          ok: true,
          pid: process.pid,
          uptimeMs: Date.now() - started,
          folder: folder?.root ?? null,
        });
      if (path === "/ws/state" || path === "/ws/inbox") {
        const kind = path === "/ws/state" ? "state" : "inbox";
        return server.upgrade(req, { data: { kind, repo } }) ? undefined : json({ ok: false }, 400);
      }
      const ws = /^\/ws\/(activity|pty)\/([^/]+)$/.exec(path);
      if (ws) {
        const data: Socket = {
          kind: ws[1] as "activity" | "pty",
          repo,
          runId: ws[2] as string,
          by: url.searchParams.get("by") ?? undefined,
        };
        return server.upgrade(req, { data }) ? undefined : json({ ok: false }, 400);
      }
      if (path === "/state") return json(await state(ctx, folder));
      if (path === "/inbox") return json(await inbox(ctx, folder));
      if (path === "/conflicts") {
        const c = containerFor(repo);
        if (c.isErr()) return json({ ok: false, error: c.error }, 404);
        return fromResult(await c.value.resolve("worktreeConflicts").execute({}));
      }
      const c = containerFor(repo);
      if (c.isErr()) return json({ ok: false, error: c.error }, 404);
      if (path === "/workflows") {
        const scan = await c.value.resolve("workflowCatalog").scan();
        return json({
          ok: true,
          data: {
            workflows: scan.workflows.map(({ spec, source }) => ({
              id: spec.id,
              revision: spec.revision,
              ...(spec.description ? { description: spec.description } : {}),
              stages: spec.stages.map((st) => st.id),
              source,
            })),
          },
        });
      }
      if (path === "/report")
        return fromResult(
          await c.value.resolve("buildReport").execute(url.searchParams.get("since") ?? undefined),
        );
      if (path === "/supervisor") return json(await supervisorView(c.value, repo, folder, started, opts));
      if (path === "/runs" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Json;
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        const init = await c.value.resolve("initRun").execute({
          workflow: str("workflow") ?? "",
          task: str("task") ?? "",
          ...(str("autonomy") ? { autonomy: str("autonomy") as "L0" | "L1" | "L2" } : {}),
          ...(body.worktree === true ? { worktree: {} } : {}),
          ...(str("parent") ? { parent: str("parent") as string } : {}),
        });
        if (init.isErr()) return fromResult(init);
        const runId = init.value.runId;
        const setup =
          body.worktree === true && body.setup !== false
            ? await c.value.resolve("setupWorktree").execute({ run: runId })
            : undefined;
        const host = str("drive");
        const drive = host && opts.start ? await opts.start(c.value, runId, host) : undefined;
        return json({
          ok: true,
          data: {
            run: init.value,
            ...(setup ? { setup: setup.isOk() ? setup.value : { error: setup.error.message } } : {}),
            ...(drive
              ? { drive: drive.isOk() ? { host, ...drive.value } : { error: drive.error.message } }
              : {}),
          },
        });
      }
      const run = /^\/runs\/([^/]+)\/([a-z-]+)$/.exec(path);
      if (!run)
        return json(
          { ok: false, error: { code: "NOT_FOUND", message: `no route ${req.method} ${path}` } },
          404,
        );
      const [, runId, action] = run as unknown as [string, string, string];
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Json) : {};
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
      const list = (k: string) => (Array.isArray(body[k]) ? (body[k] as string[]) : []);
      switch (`${req.method} ${action}`) {
        case "GET activity": {
          const tail = Number(url.searchParams.get("tail")) || undefined;
          const a = await c.value.resolve("runJournal").activity(runId);
          return fromResult(a.map((entries) => ({ runId, entries: tail ? entries.slice(-tail) : entries })));
        }
        case "GET brief": {
          const journal = c.value.resolve("runJournal");
          const record = await c.value.resolve("runRepository").load(runId);
          if (record.isErr()) return fromResult(record);
          const seen = await journal.seen(runId);
          if (seen.isErr()) return fromResult(seen);
          const given = url.searchParams.get("since");
          const since =
            given && !Number.isNaN(Date.parse(given))
              ? new Date(given).toISOString()
              : (seen.value ?? record.value.createdAt);
          const activity = await journal.activity(runId);
          if (activity.isErr()) return fromResult(activity);
          return json({
            ok: true,
            data: {
              runId,
              status: record.value.state.status,
              stage: record.value.state.stage,
              ...briefOf(activity.value, since),
            },
          });
        }
        case "POST seen":
          return fromResult(
            (await c.value.resolve("runJournal").markSeen(runId)).map((at) => ({ runId, at })),
          );
        case "GET messages":
          return fromResult(
            (await c.value.resolve("runMessages").list(runId)).map((messages) => ({ runId, messages })),
          );
        case "GET pty": {
          const broker = c.value.resolve("ptyBroker");
          return json({
            ok: true,
            data: { session: broker.status(runId) ?? null, backlog: broker.backlog(runId) },
          });
        }
        case "POST attach":
          return fromResult(await c.value.resolve("driverLock").attach({ runId, by: str("by") ?? "" }));
        case "POST release":
          return fromResult(await c.value.resolve("driverLock").release({ runId }));
        case "POST answer":
          return fromResult(
            await c.value.resolve("runJournal").answer(runId, str("question") ?? "", {
              choices: list("choices"),
              ...(str("text") ? { text: str("text") as string } : {}),
              by: str("by") ?? "",
              // From the decision card, without opening the session: what 11a counts.
              ...(str("origin") === "inbox" ? { origin: "inbox" as const } : {}),
            }),
          );
        case "POST approve":
          return fromResult(
            await c.value.resolve("approveRun").execute({
              runId,
              gate: str("gate") ?? "",
              by: str("by") ?? "",
              ...(str("choice") ? { choice: str("choice") as string } : {}),
              ...(str("via") === "chat" ? { via: "chat" as const } : {}),
            }),
          );
        case "POST message":
          return fromResult(
            await c.value.resolve("runMessages").send({
              from: str("from") ?? "",
              to: runId,
              topic: (str("topic") ?? "info") as "info" | "contract" | "shared-file" | "done",
              text: str("text") ?? "",
              refs: list("refs"),
              by: str("by") ?? "",
            }),
          );
        case "POST pty-open":
          return fromResult(
            await c.value.resolve("ptyBroker").open({
              runId,
              ...(str("host") ? { host: str("host") as string } : {}),
              ...(typeof body.cols === "number" && typeof body.rows === "number"
                ? { size: { cols: body.cols as number, rows: body.rows as number } }
                : {}),
            }),
          );
        case "POST pty-close":
          return fromResult(await c.value.resolve("ptyBroker").close(runId));
        default:
          return json(
            { ok: false, error: { code: "NOT_FOUND", message: `no route ${req.method} ${path}` } },
            404,
          );
      }
    },
    websocket: {
      async open(ws) {
        sockets.add(ws);
        const d = ws.data;
        if (d.kind === "state" || d.kind === "inbox") {
          let last = "";
          const tick = async () => {
            const text = JSON.stringify(
              d.kind === "state" ? await state(ctx, folder) : await inbox(ctx, folder),
            );
            if (text !== last) {
              last = text;
              ws.send(text);
            }
          };
          await tick();
          const timer = setInterval(() => void tick(), pollMs);
          d.stop = () => clearInterval(timer);
          return;
        }
        const c = containerFor(d.repo);
        if (c.isErr()) {
          ws.send(JSON.stringify({ type: "error", error: c.error }));
          ws.close();
          return;
        }
        const runId = d.runId as string;
        if (d.kind === "activity") {
          let seen = 0;
          const tick = async () => {
            const a = await c.value.resolve("runJournal").activity(runId);
            if (a.isErr()) return;
            for (const entry of a.value.slice(seen)) ws.send(JSON.stringify({ type: "activity", entry }));
            seen = a.value.length;
          };
          await tick();
          const timer = setInterval(() => void tick(), pollMs);
          d.stop = () => clearInterval(timer);
          return;
        }
        const broker = c.value.resolve("ptyBroker");
        const opened = await broker.open({ runId });
        if (opened.isErr()) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: { code: opened.error.code, message: opened.error.message },
            }),
          );
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "session", session: opened.value }));
        const backlog = broker.backlog(runId);
        if (backlog) ws.send(JSON.stringify({ type: "data", data: backlog }));
        d.stop = broker.subscribe(runId, (event: PtyEvent) => ws.send(JSON.stringify(event)));
      },
      async message(ws, raw) {
        const d = ws.data;
        if (d.kind !== "pty") return;
        const c = containerFor(d.repo);
        if (c.isErr()) return;
        const broker = c.value.resolve("ptyBroker");
        let msg: Json;
        try {
          msg = JSON.parse(String(raw)) as Json;
        } catch {
          ws.send(
            JSON.stringify({
              type: "refused",
              reason: "messages are JSON: {type: input, data} or {type: resize, cols, rows}",
            }),
          );
          return;
        }
        if (msg.type === "input" && typeof msg.data === "string") {
          const r = await broker.write({ runId: d.runId as string, data: msg.data, by: d.by ?? "" });
          if (r.isErr()) ws.send(JSON.stringify({ type: "refused", reason: r.error.message }));
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          broker.resize(d.runId as string, { cols: msg.cols, rows: msg.rows });
        }
      },
      close(ws) {
        ws.data.stop?.();
        sockets.delete(ws);
      },
    },
  });
  // The supervisor: one tick per interval for every repository the daemon serves.
  const supervisors = new Map<string, Supervisor>();
  const restart = opts.restart;
  const superviseTimer =
    opts.superviseMs && restart
      ? setInterval(() => {
          const repos = folder ? folder.repos.map((r) => r.name) : [undefined];
          for (const repo of repos) {
            const c = containerFor(repo);
            if (c.isErr()) continue;
            const key = repo ?? ".";
            const container = c.value;
            const s =
              supervisors.get(key) ?? container.resolve("supervisor")((runId) => restart(container, runId));
            supervisors.set(key, s);
            void s.tick();
          }
        }, opts.superviseMs)
      : undefined;
  const port = server.port ?? opts.port;
  if (opts.announce) {
    const serving = {
      port,
      hostname: opts.hostname,
      pid: process.pid,
      url: `http://${opts.hostname}:${port}`,
    };
    process.stderr.write(`${JSON.stringify({ serving })}\n`);
  }
  return {
    port,
    hostname: opts.hostname,
    pid: process.pid,
    stop: async () => {
      if (superviseTimer) clearInterval(superviseTimer);
      for (const ws of sockets) ws.close();
      await server.stop(true);
    },
  };
}

/** The same overview `metator status` prints: one repository, or each repository of a folder. */
export async function state(ctx: CommandContext, folder: Folder | null): Promise<Json> {
  if (!folder) {
    const o = await ctx.container().resolve("workOverview").execute();
    return o.isOk()
      ? { ok: true, data: o.value }
      : { ok: false, error: { code: o.error.code, message: o.error.message } };
  }
  const repos: Json[] = [];
  for (const r of folder.repos) {
    const o = await ctx.containerAt(r.root).resolve("workOverview").execute();
    repos.push({ name: r.name, path: r.path, ...(o.isOk() ? o.value : { error: o.error.message }) });
  }
  return { ok: true, data: { folder: folder.root, repos } };
}

/** The same queue `metator inbox` prints. */
export async function inbox(ctx: CommandContext, folder: Folder | null): Promise<Json> {
  const roots = folder ? folder.repos.map((r) => ({ name: r.name, root: r.root })) : [{ name: "", root: "" }];
  const items: (InboxItem & { repo?: string })[] = [];
  for (const r of roots) {
    const c = r.root ? ctx.containerAt(r.root) : ctx.container();
    const o = await c.resolve("workOverview").execute();
    if (o.isErr()) continue;
    for (const item of inboxOf(o.value.runs, c.resolve("clock").now()))
      items.push(folder ? { repo: r.name, ...item } : item);
  }
  return { ok: true, data: { decisions: items.sort(byUrgency) } };
}

const ok = <T>(value: T) => ({ isOk: () => true, isErr: () => false, value }) as unknown as Result<T, never>;
const err = <E>(error: E) => ({ isOk: () => false, isErr: () => true, error }) as unknown as Result<never, E>;

/**
 * What the Supervisor screen shows: the daemon, its hosts and policy, the live PTY sessions,
 * and the acceptance figures (11a, 11b) from the same facts as `metator report`.
 */
export async function supervisorView(
  c: MetatorContainer,
  repo: string | undefined,
  folder: Folder | null,
  startedAt: number,
  opts: Pick<ServeOptions, "port" | "hostname" | "superviseMs">,
): Promise<Json> {
  const policy = c.resolve("config").config.supervisor;
  const facts = await c.resolve("buildReport").facts();
  if (facts.isErr()) return { ok: false, error: { code: facts.error.code, message: facts.error.message } };
  const journal = c.resolve("runJournal");
  const runs: Parameters<typeof acceptanceStats>[0][number][] = [];
  for (const f of facts.value) {
    const a = await journal.activity(f.runId);
    runs.push({ questions: f.questions, activity: a.isOk() ? [...a.value] : [] });
  }
  const dayAgo = new Date(c.resolve("clock").now().getTime() - 24 * 3600 * 1000).toISOString();
  return {
    ok: true,
    data: {
      daemon: {
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        url: `http://${opts.hostname}:${opts.port}`,
        superviseMs: opts.superviseMs ?? 0,
        folder: folder?.root ?? null,
        repo: repo ?? null,
      },
      hosts: [...c.resolve("interactiveHosts").keys()],
      policy,
      sessions: c.resolve("ptyBroker").list(),
      acceptance: { since: dayAgo, ...acceptanceStats(runs, dayAgo) },
    },
  };
}
