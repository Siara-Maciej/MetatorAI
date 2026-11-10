import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceStats,
  briefOf,
  byUrgency,
  DAEMON_FILE,
  DaemonInfoDocument,
  type InboxItem,
  inboxOf,
  MetatorError,
  OPTION_SCOPES,
  type OptionScope,
  PANE_ROLES,
  PANE_STATES,
  type PaneRole,
  type PaneState,
  type PtyEvent,
  type PtyView,
  type Result,
  SplitNodeSchema,
  type Supervisor,
  serializeJsonDocument,
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
  readonly kind: "state" | "inbox" | "options" | "activity" | "pty" | "pane";
  readonly repo: string | undefined;
  readonly runId?: string | undefined;
  /** The pane a `pty` or `pane` socket streams; set once the pane is known. */
  paneId?: string | undefined;
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
      if (path === "/ws/state" || path === "/ws/inbox" || path === "/ws/options") {
        const kind = path === "/ws/state" ? "state" : path === "/ws/inbox" ? "inbox" : "options";
        return server.upgrade(req, { data: { kind, repo } }) ? undefined : json({ ok: false }, 400);
      }
      const ws = /^\/ws\/(activity|pty|pane)\/([^/]+)$/.exec(path);
      if (ws) {
        const kind = ws[1] as "activity" | "pty" | "pane";
        const data: Socket = {
          kind,
          repo,
          ...(kind === "pane" ? { paneId: decodeURIComponent(ws[2] as string) } : { runId: ws[2] as string }),
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
      if (path === "/layout") return fromResult(await c.value.resolve("panes").view());
      // Options (S1): every option with its value and source; a set writes the scope's file.
      if (path === "/options" && req.method === "GET")
        return fromResult(
          await c.value.resolve("optionStore").list({
            ...(url.searchParams.get("run") ? { runId: url.searchParams.get("run") as string } : {}),
            changed: url.searchParams.get("changed") === "true",
          }),
        );
      if (path === "/options/schema")
        return json({ ok: true, data: c.value.resolve("optionStore").schema() });
      // The backlog (S4): read, add (a person), decide, edit, close, drop, start.
      if (path === "/issues" && req.method === "GET")
        return fromResult(
          (
            await c.value.resolve("issues").list({
              ...(url.searchParams.get("run") ? { runId: url.searchParams.get("run") as string } : {}),
            })
          ).map((issues) => ({ issues })),
        );
      if (path === "/issues" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Json;
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        return fromResult(
          await c.value.resolve("issues").add({
            title: str("title") ?? "",
            ...(str("body") !== undefined ? { body: str("body") as string } : {}),
            ...(str("priority") ? { priority: str("priority") as "low" | "normal" | "high" } : {}),
            ...(Array.isArray(body.labels) ? { labels: body.labels as string[] } : {}),
            ...(Array.isArray(body.refs) ? { refs: body.refs as never[] } : {}),
            by: str("by") ?? "",
          }),
        );
      }
      const issueRoute = /^\/issues\/([^/]+)\/(decide|edit|close|drop|start)$/.exec(path);
      if (issueRoute && req.method === "POST") {
        const [, id, what] = issueRoute as unknown as [string, string, string];
        const body = (await req.json().catch(() => ({}))) as Json;
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        const issues = c.value.resolve("issues");
        const patch = {
          ...(str("title") !== undefined ? { title: str("title") as string } : {}),
          ...(str("body") !== undefined ? { body: str("body") as string } : {}),
          ...(str("priority") ? { priority: str("priority") as "low" | "normal" | "high" } : {}),
          ...(Array.isArray(body.labels) ? { labels: body.labels as string[] } : {}),
          ...(Array.isArray(body.refs) ? { refs: body.refs as never[] } : {}),
        };
        switch (what) {
          case "decide":
            return fromResult(
              await issues.decide(id, {
                by: str("by") ?? "",
                decision: body.decision === "drop" ? "drop" : "add",
                ...patch,
              }),
            );
          case "edit":
            return fromResult(await issues.edit(id, patch));
          case "close":
            return fromResult(await issues.close(id, { by: str("by") ?? "" }));
          case "drop":
            return fromResult(await issues.drop(id, { by: str("by") ?? "" }));
          default:
            return fromResult(
              await issues.start(id, {
                workflow: str("workflow") ?? "",
                ...(body.worktree === false ? { worktree: false } : {}),
                ...(str("autonomy") ? { autonomy: str("autonomy") as "L0" | "L1" | "L2" } : {}),
              }),
            );
        }
      }
      const option = /^\/options\/(.+)$/.exec(path);
      if (option && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Json;
        const key = decodeURIComponent(option[1] as string);
        const scope = OPTION_SCOPES.includes(body.scope as OptionScope)
          ? (body.scope as OptionScope)
          : "user";
        const runId = typeof body.runId === "string" ? (body.runId as string) : undefined;
        const store = c.value.resolve("optionStore");
        return fromResult(
          body.reset === true
            ? await store.unset({ key, scope, ...(runId ? { runId } : {}) })
            : await store.set({ key, scope, value: body.value, ...(runId ? { runId } : {}) }),
        );
      }
      if (path === "/panes" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Json;
        const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
        const panes = c.value.resolve("panes");
        // A pane of a run's workspace (made when missing) or of a named workspace.
        let workspace = str("workspace");
        if (!workspace && (str("runId") || body.runId === undefined)) {
          const w = await panes.openWorkspace({
            ...(str("runId") ? { runId: str("runId") as string } : {}),
            ...(str("label") && !str("runId") ? { label: str("label") as string } : {}),
          });
          if (w.isErr()) return fromResult(w);
          workspace = w.value.id;
        }
        const role = PANE_ROLES.includes(str("role") as PaneRole) ? (str("role") as PaneRole) : "shell";
        const argv = Array.isArray(body.argv) ? (body.argv as string[]) : undefined;
        // A fresh tab for the pane (S6): named after the pane's label.
        let tab = str("tab");
        if (body.newTab === true && workspace) {
          const opened = await panes.openTab(workspace, str("label") ?? "tab");
          if (opened.isErr()) return fromResult(opened);
          tab = opened.value;
        }
        return fromResult(
          await panes.openPane({
            workspace: workspace as string,
            ...(tab ? { tab } : {}),
            role,
            ...(str("label") ? { label: str("label") as string } : {}),
            ...(str("cwd") ? { cwd: str("cwd") as string } : {}),
            process: argv
              ? { kind: "command", argv }
              : {
                  kind: "host",
                  ...(str("host") ? { host: str("host") as string } : {}),
                  agent: str("agent") ?? "session",
                  prompt: str("prompt") ?? "",
                },
            ...(typeof body.cols === "number" && typeof body.rows === "number"
              ? { size: { cols: body.cols as number, rows: body.rows as number } }
              : {}),
          }),
        );
      }
      const pane = /^\/panes\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
      if (pane) {
        const [, rawPane, action] = pane as unknown as [string, string, string | undefined];
        const paneId = decodeURIComponent(rawPane);
        const panes = c.value.resolve("panes");
        const broker = c.value.resolve("ptyBroker");
        if (!action && req.method === "GET") {
          const lines = Number(url.searchParams.get("lines")) || 80;
          const view = await panes.pane(paneId);
          return fromResult(
            view.map((p) => ({ pane: p, text: panes.read(paneId, lines), backlog: broker.backlog(paneId) })),
          );
        }
        if (action === "wait" && req.method === "GET") {
          const until = (url.searchParams.get("until") ?? "idle,exited")
            .split(",")
            .filter((u): u is PaneState => (PANE_STATES as readonly string[]).includes(u));
          const timeoutMs = Number(url.searchParams.get("timeout")) || 60_000;
          return fromResult(await panes.wait(paneId, { until, timeoutMs }));
        }
        if (action === "close" && req.method === "POST") return fromResult(await panes.closePane(paneId));
        // Split (S6): a shell (the person's `terminal.shell`, else $SHELL) beside or below the pane.
        if (action === "split" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Json;
          const dir = body.dir === "down" ? "down" : "right";
          const argv = Array.isArray(body.argv) && body.argv.length > 0 ? (body.argv as string[]) : undefined;
          const shell = await c.value.resolve("optionStore").get("terminal.shell");
          const configured = shell.isOk() && typeof shell.value.value === "string" ? shell.value.value : "";
          const fallback = configured !== "" ? configured : (process.env.SHELL ?? "sh");
          return fromResult(
            await panes.splitPane(paneId, {
              dir,
              process: { kind: "command", argv: argv ?? [fallback] },
              ...(typeof body.cols === "number" && typeof body.rows === "number"
                ? { size: { cols: body.cols as number, rows: body.rows as number } }
                : {}),
            }),
          );
        }
        // A hook of the pane's own session says the agent works (R3): the pane's token, no other.
        if (action === "heartbeat" && req.method === "POST") {
          const token = req.headers.get("x-metator-pane");
          const own = token ? await panes.authorize(token) : undefined;
          if (!own || own.id !== paneId)
            return json(
              {
                ok: false,
                error: { code: "FORBIDDEN", message: `only pane ${paneId} itself reports its heartbeat` },
              },
              403,
            );
          return fromResult(broker.heartbeat(paneId).map(() => ({ paneId, at: new Date().toISOString() })));
        }
        if (action === "state" && req.method === "GET")
          return fromResult(await c.value.resolve("paneSensor").state(paneId));
        return json(
          { ok: false, error: { code: "NOT_FOUND", message: `no route ${req.method} ${path}` } },
          404,
        );
      }
      const tabTree = /^\/tabs\/([^/]+)\/tree$/.exec(path);
      if (tabTree && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as Json;
        const tree = SplitNodeSchema.safeParse(body.tree);
        if (!tree.success)
          return json({ ok: false, error: { code: "USAGE", message: "body.tree is not a split tree" } }, 400);
        return fromResult(
          await c.value.resolve("panes").setTree(decodeURIComponent(tabTree[1] as string), tree.data),
        );
      }
      const workspace = /^\/workspaces\/([^/]+)\/close$/.exec(path);
      if (workspace && req.method === "POST")
        return fromResult(
          await c.value.resolve("panes").closeWorkspace(decodeURIComponent(workspace[1] as string)),
        );
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
      // A call from inside a pane carries the pane's token: it may steer its own run only, and
      // only from the conductor's pane (R2). A call without a token is a person's.
      const token = req.headers.get("x-metator-pane");
      if (token && ["start", "delegate", "collect"].includes(action)) {
        const pane = await c.value.resolve("panes").authorize(token);
        if (!pane || pane.runId !== runId || pane.role !== "conductor")
          return json(
            {
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: pane
                  ? `pane ${pane.id} (${pane.role}${pane.runId ? ` of run ${pane.runId}` : ""}) may not steer run ${runId}`
                  : "unknown pane token",
                hint: "Only the run's conductor pane delegates and collects; a worker reports with `metator run result`.",
              },
            },
            403,
          );
      }
      switch (`${req.method} ${action}`) {
        case "POST start":
          return fromResult(
            await c.value
              .resolve("conductor")
              .start({ runId, ...(str("host") ? { host: str("host") as string } : {}) }),
          );
        case "POST delegate":
          return fromResult(
            await c.value.resolve("conductor").delegate({
              runId,
              ...(str("stage") ? { stage: str("stage") as string } : {}),
              agent: str("agent") ?? "",
              card: str("card") ?? "",
              ...(str("name") ? { name: str("name") as string } : {}),
              ...(str("host") ? { host: str("host") as string } : {}),
            }),
          );
        case "GET workers":
          return fromResult(
            (await c.value.resolve("conductor").workers(runId)).map((workers) => ({ runId, workers })),
          );
        case "GET wait":
          return fromResult(
            await c.value.resolve("conductor").wait({
              runId,
              worker: url.searchParams.get("worker") ?? "",
              timeoutMs: Number(url.searchParams.get("timeout")) || 60_000,
            }),
          );
        case "POST collect":
          return fromResult(
            await c.value.resolve("conductor").collect({ runId, worker: str("worker") ?? "" }),
          );
        case "GET board":
          return fromResult(
            await c.value.resolve("planBoard").execute({
              runId,
              ...(Number(url.searchParams.get("timeline"))
                ? { timeline: Number(url.searchParams.get("timeline")) }
                : {}),
            }),
          );
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
          const conductor = broker.byRun(runId)[0];
          return json({
            ok: true,
            data: { session: conductor ?? null, backlog: conductor ? broker.backlog(conductor.paneId) : "" },
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
            (
              await c.value.resolve("panes").openRun({
                runId,
                ...(str("host") ? { host: str("host") as string } : {}),
                ...(typeof body.cols === "number" && typeof body.rows === "number"
                  ? { size: { cols: body.cols as number, rows: body.rows as number } }
                  : {}),
              })
            ).map((p) => p.live),
          );
        case "POST close-panes":
          return fromResult(await c.value.resolve("panes").closeRun(runId));
        case "POST pty-close": {
          const conductor = c.value.resolve("ptyBroker").byRun(runId)[0];
          if (!conductor) return json({ ok: true, data: { closed: false } });
          return fromResult(await c.value.resolve("panes").closePane(conductor.paneId));
        }
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
        if (d.kind === "state" || d.kind === "inbox" || d.kind === "options") {
          let last = "";
          const tick = async () => {
            const text = JSON.stringify(
              d.kind === "state"
                ? await state(ctx, folder)
                : d.kind === "inbox"
                  ? await inbox(ctx, folder)
                  : await optionsView(containerFor(d.repo)),
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
        const panes = c.value.resolve("panes");
        // A run's socket opens (or finds) its conductor pane; a pane's socket needs a live pane.
        const opened =
          d.kind === "pane"
            ? (await panes.pane(d.paneId as string)).andThen((p) =>
                p.live ? ok(p.live) : err(MetatorError.notFound(`a terminal in pane ${d.paneId}`)),
              )
            : (await panes.openRun({ runId })).map((p) => p.live as PtyView);
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
        d.paneId = opened.value.paneId;
        ws.send(JSON.stringify({ type: "session", session: opened.value }));
        const backlog = broker.backlog(opened.value.paneId);
        if (backlog) ws.send(JSON.stringify({ type: "data", data: backlog }));
        d.stop = broker.subscribe(opened.value.paneId, (event: PtyEvent) => ws.send(JSON.stringify(event)));
      },
      async message(ws, raw) {
        const d = ws.data;
        if ((d.kind !== "pty" && d.kind !== "pane") || !d.paneId) return;
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
          const r = await broker.write({ paneId: d.paneId, data: msg.data, by: d.by ?? "" });
          if (r.isErr()) ws.send(JSON.stringify({ type: "refused", reason: r.error.message }));
        } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          broker.resize(d.paneId, { cols: msg.cols, rows: msg.rows });
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
            void s.tick().then((r) => {
              if (r.isErr())
                process.stderr.write(
                  `${JSON.stringify({ supervisor: { repo: key, error: r.error.message } })}\n`,
                );
            });
          }
        }, opts.superviseMs)
      : undefined;
  const port = server.port ?? opts.port;
  // Where the daemon listens, for the CLI and the clients; and every pane of the layout back.
  const roots = folder ? folder.repos.map((r) => r.root) : [ctx.container().resolve("root")];
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
    const r = await c.value.resolve("panes").restore();
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
      if (superviseTimer) clearInterval(superviseTimer);
      for (const root of roots) rmSync(join(root, DAEMON_FILE), { force: true });
      for (const ws of sockets) ws.close();
      await server.stop(true);
    },
  };
}

/** The same overview `metator status` prints: one repository, or each repository of a folder. */
export /** `/ws/options`: the options view as an envelope, so the app refreshes when a file changes. */
async function optionsView(c: Result<MetatorContainer, { code: string; message: string }>): Promise<unknown> {
  if (c.isErr()) return { ok: false, error: c.error };
  const view = await c.value.resolve("optionStore").list({});
  return view.isOk()
    ? { ok: true, data: view.value }
    : { ok: false, error: { code: view.error.code, message: view.error.message } };
}

async function state(ctx: CommandContext, folder: Folder | null): Promise<Json> {
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
