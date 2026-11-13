import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceStats,
  DAEMON_FILE,
  DaemonInfoDocument,
  type ErrorCode,
  fleetInbox,
  type MessageTopic,
  MetatorError,
  OPTION_SCOPES,
  type OptionScope,
  type Overview,
  PANE_ROLES,
  PANE_STATES,
  type PaneRole,
  type PaneState,
  type PtyEvent,
  type PtyView,
  type RepoRuns,
  type Result,
  SplitNodeSchema,
  type Supervisor,
  serializeJsonDocument,
  withNeedsText,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { CommandContext, Folder } from "../context.ts";
import { liveDaemonAt } from "../daemon-client.ts";

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

type Json = Record<string, unknown>;

interface Socket {
  readonly kind: "state" | "inbox" | "activity" | "pty" | "pane";
  readonly repo: string | undefined;
  readonly runId?: string | undefined;
  /** The pane a `pty` or `pane` socket streams; set once the pane is known. */
  paneId?: string | undefined;
  readonly by?: string | undefined;
  stop?: () => void;
  /** Resolves once a `pty` or `pane` socket has found its pane: input waits for it. */
  ready?: Promise<void>;
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
    : json(
        {
          ok: false,
          error: {
            code: r.error.code,
            message: r.error.message,
            hint: r.error.hint,
            // What the app decides from (a refusal it can offer a way past), never prose.
            ...(r.error.details ? { details: r.error.details } : {}),
          },
        },
        400,
      );

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
  const served = (o: Overview): Overview => ({
    ...o,
    runs: o.runs.map((r) => ({ ...r, questions: r.questions.map(withNeedsText) })),
  });
  /** The same overview `metator status` prints: one repository, or each repository of a folder. */
  const state = async (fresh: boolean): Promise<Json> => {
    const views = repoViews();
    if (!folder) {
      const only = views[0] as (typeof views)[number];
      const o = await overviewOf(only.key, only.c, fresh);
      return o.isOk()
        ? { ok: true, data: served(o.value) }
        : { ok: false, error: { code: o.error.code, message: o.error.message } };
    }
    const repos: Json[] = [];
    for (const r of views) {
      const o = await overviewOf(r.key, r.c, fresh);
      repos.push({
        name: r.name,
        path: r.path,
        ...(o.isOk() ? served(o.value) : { error: o.error.message }),
      });
    }
    return { ok: true, data: { folder: folder.root, repos } };
  };
  /** The same queue `metator inbox` prints. */
  const inbox = async (fresh: boolean): Promise<Json> => {
    const repos: RepoRuns[] = [];
    for (const r of repoViews()) {
      const o = await overviewOf(r.key, r.c, fresh);
      if (o.isErr()) continue;
      repos.push({ name: r.name, runs: o.value.runs, now: r.c.resolve("clock").now() });
    }
    const queue = fleetInbox(repos, folder !== null);
    return {
      ok: true,
      data: {
        decisions: queue.decisions.map((d) => ({ ...d, question: withNeedsText(d.question) })),
        escalated: queue.escalated,
      },
    };
  };

  const server = Bun.serve<Socket>({
    port: opts.port,
    hostname: opts.hostname,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const repo = url.searchParams.get("repo") ?? undefined;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      // A request that may change a run: the sockets' next tick reads the runs again.
      if (req.method !== "GET") overviews.clear();
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
      if (path === "/state") return json(await state(true));
      if (path === "/inbox") return json(await inbox(true));
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
              // The levels the workflow runs at: the form offers only these.
              ...(spec.autonomy ? { autonomy: spec.autonomy } : {}),
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
      if (path === "/supervisor")
        return json(
          // The port the daemon is bound to: with `--port 0` that is not the one it was asked for.
          await supervisorView(c.value, repo, folder, started, { ...opts, port: server.port ?? opts.port }),
        );
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
                ...(body.allowDirty === true ? { allowDirty: true } : {}),
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
      if (path === "/mrs" && req.method === "GET") {
        const all = await c.value.resolve("myReviews").list();
        return fromResult(all.map((requests) => ({ requests })));
      }
      const mr = /^\/mrs\/([^/]+)(?:\/(send|resolve))?$/.exec(path);
      if (mr) {
        const [, rawId, verb] = mr as unknown as [string, string, string | undefined];
        const id = decodeURIComponent(rawId);
        const reviews = c.value.resolve("myReviews");
        if (!verb && req.method === "GET") return fromResult(await reviews.show(id));
        if (verb && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Json;
          const by = typeof body.by === "string" ? body.by : "";
          if (verb === "send") return fromResult(await reviews.send(id, { by }));
          return fromResult(
            await reviews.resolve(id, typeof body.thread === "string" ? body.thread : "", { by }),
          );
        }
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
        // A shell pane asked for without a command runs the person's shell, as a split does.
        const argv = Array.isArray(body.argv)
          ? (body.argv as string[])
          : str("role") === "shell" && !str("host") && !str("agent")
            ? [await defaultShell(c.value)]
            : undefined;
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
        // The editor on the pane's directory (S5), at a file and line when given.
        if (action === "open-editor" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Json;
          return fromResult(
            await c.value.resolve("openEditor").execute({
              paneId,
              ...(typeof body.file === "string" ? { file: body.file } : {}),
              ...(typeof body.line === "number" ? { line: body.line } : {}),
            }),
          );
        }
        // Split (S6): a shell (the person's `terminal.shell`, else $SHELL) beside or below the pane.
        if (action === "split" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as Json;
          const dir = body.dir === "down" ? "down" : "right";
          const argv = Array.isArray(body.argv) && body.argv.length > 0 ? (body.argv as string[]) : undefined;
          return fromResult(
            await panes.splitPane(paneId, {
              dir,
              process: { kind: "command", argv: argv ?? [await defaultShell(c.value)] },
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
                error: {
                  code: DENIED,
                  message: `only pane ${paneId} itself reports its heartbeat`,
                },
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
        // The same start as `metator run new`: the run, its worktree's dependencies, its drive.
        const host = str("drive");
        const started = await c.value.resolve("startRun").execute({
          workflow: str("workflow") ?? "",
          task: str("task") ?? "",
          ...(str("autonomy") ? { autonomy: str("autonomy") as "L0" | "L1" | "L2" } : {}),
          ...(body.worktree === true
            ? { worktree: body.allowDirty === true ? { allowDirty: true } : {} }
            : body.allowDirty === true
              ? { allowDirty: true }
              : {}),
          ...(str("parent") ? { parent: str("parent") as string } : {}),
          setup: body.setup !== false,
          ...(host ? { drive: { host } } : {}),
        });
        if (started.isErr()) return fromResult(started);
        const { run: created, setup, setupError, drive, driveError, warnings } = started.value;
        return json({
          ok: true,
          data: {
            run: created,
            ...(setup ? { setup } : setupError ? { setup: { error: setupError } } : {}),
            ...(drive
              ? { drive: { host, stage: drive.stage, started: drive.started } }
              : driveError
                ? { drive: { error: driveError.message } }
                : {}),
          },
          ...(warnings.length > 0 ? { warnings } : {}),
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
                code: DENIED,
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
        // The editor, the change and the notes on it (S5).
        case "POST open-editor":
          return fromResult(
            await c.value.resolve("openEditor").execute({
              runId,
              ...(str("file") ? { file: str("file") as string } : {}),
              ...(typeof body.line === "number" ? { line: body.line as number } : {}),
            }),
          );
        case "GET review":
          return fromResult(
            await c.value.resolve("runChanges").execute({
              runId,
              ...(url.searchParams.get("file") ? { file: url.searchParams.get("file") as string } : {}),
            }),
          );
        case "GET review-notes":
          return fromResult(await c.value.resolve("reviewNotes").list(runId));
        case "POST review-notes":
          return fromResult(
            await c.value.resolve("reviewNotes").add(runId, {
              ...(str("file") ? { file: str("file") as string } : {}),
              ...(typeof body.line === "number" ? { line: body.line as number } : {}),
              ...(str("side") === "old" || str("side") === "new"
                ? { side: str("side") as "old" | "new" }
                : {}),
              text: str("text") ?? "",
              by: str("by") ?? "",
            }),
          );
        case "POST review-send":
          return fromResult(await c.value.resolve("reviewNotes").send(runId, { by: str("by") ?? "" }));
        case "POST review-note-status":
          return fromResult(
            await c.value
              .resolve("reviewNotes")
              .setStatus(
                runId,
                str("id") ?? "",
                (str("status") ?? "addressed") as "draft" | "sent" | "addressed",
              ),
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
          // The same brief as `metator run brief --peek`: a `since` that is no time is a usage error
          // here too; reading it marks nothing (`POST seen` does).
          const since = url.searchParams.get("since");
          return fromResult(
            await c.value.resolve("briefRun").execute({ runId, peek: true, ...(since ? { since } : {}) }),
          );
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
        case "POST answer": {
          // The same answer as `metator run answer` (`always`: also a policy); carried out by a drive:
          // with none alive on an active run, the run is driven again. Never an escalated run.
          return fromResult(
            await c.value.resolve("answerQuestion").execute({
              runId,
              question: str("question") ?? "",
              choices: list("choices"),
              ...(str("text") ? { text: str("text") as string } : {}),
              by: str("by") ?? "",
              // From the decision card, without opening the session: what 11a counts.
              ...(str("origin") === "inbox" ? { origin: "inbox" as const } : {}),
              always: body.always === true,
              drive: true,
            }),
          );
        }
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
        // An escalated run back at its stage, and driven on at once (R9): what the app's Resume does.
        case "POST resume": {
          const resumed = await c.value.resolve("resumeRun").execute({ runId, by: str("by") ?? "" });
          if (resumed.isErr()) return fromResult(resumed);
          const drive =
            body.drive === false
              ? undefined
              : await c.value
                  .resolve("ensureDriven")
                  .execute({ runId, ...(str("host") ? { host: str("host") as string } : {}) });
          return json({
            ok: true,
            data: {
              run: resumed.value,
              ...(drive
                ? {
                    drive: drive.isOk()
                      ? { stage: drive.value.stage, started: drive.value.started }
                      : {
                          error: drive.error.message,
                          ...(drive.error.hint ? { hint: drive.error.hint } : {}),
                        },
                  }
                : {}),
            },
          });
        }
        case "POST stop":
          return fromResult((await c.value.resolve("runDrivers").stop(runId)).map((r) => ({ runId, ...r })));
        // `run close`: the summary of a finished run; with a reason, an active or escalated run is
        // aborted first, its drive stopped and its panes closed.
        case "POST close": {
          const reason = str("reason")?.trim();
          if (body.aborted === true && !reason)
            return fromResult(
              err(MetatorError.usage("say why the run is aborted: reason", "An abort records its reason.")),
            );
          // The same close as `metator run close`: the panes go with the run, the worktree when asked.
          return fromResult(
            await c.value.resolve("endRun").execute({
              runId,
              ...(reason ? { abortReason: reason } : {}),
              removeWorktree: body.removeWorktree === true,
              force: body.force === true,
            }),
          );
        }
        case "POST message":
          return fromResult(
            await c.value.resolve("runMessages").send({
              from: str("from") ?? "",
              to: runId,
              topic: (str("topic") ?? "info") as MessageTopic,
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
        if (d.kind === "state" || d.kind === "inbox") {
          let last = "";
          const tick = async () => {
            const text = JSON.stringify(d.kind === "state" ? await state(false) : await inbox(false));
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
        // Input can arrive before the pane is found: `message` waits for this open to finish.
        let ready: () => void = () => {};
        d.ready = new Promise<void>((resolve) => {
          ready = resolve;
        });
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
          ready();
          ws.close();
          return;
        }
        d.paneId = opened.value.paneId;
        ready();
        ws.send(JSON.stringify({ type: "session", session: opened.value }));
        const backlog = broker.backlog(opened.value.paneId);
        if (backlog) ws.send(JSON.stringify({ type: "data", data: backlog }));
        d.stop = broker.subscribe(opened.value.paneId, (event: PtyEvent) => ws.send(JSON.stringify(event)));
      },
      async message(ws, raw) {
        const d = ws.data;
        if (d.kind !== "pty" && d.kind !== "pane") return;
        if (d.ready) await d.ready;
        if (!d.paneId) return;
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
  // Intake (T2): one scan per interval for every repository with rules; started runs are driven.
  const scanning = new Set<string>();
  const intakeTick = () => {
    const repos = folder ? folder.repos.map((r) => r.name) : [undefined];
    for (const repo of repos) {
      const c = containerFor(repo);
      if (c.isErr()) continue;
      const key = repo ?? ".";
      const container = c.value;
      if (container.resolve("config").config.intake.rules.length === 0 || scanning.has(key)) continue;
      scanning.add(key);
      void container
        .resolve("scanIntake")
        .execute()
        .then(async (r) => {
          const say = (o: object) =>
            process.stderr.write(`${JSON.stringify({ intake: { repo: key, ...o } })}\n`);
          if (r.isErr()) return say({ error: r.error.message });
          for (const rule of r.value.rules) if (rule.error) say({ rule: rule.rule, error: rule.error });
          for (const s of r.value.rules.flatMap((x) => x.started)) {
            say({ started: s.runId, issue: s.issue });
            await container.resolve("ensureDriven").execute({ runId: s.runId });
          }
        })
        .finally(() => scanning.delete(key));
    }
  };
  // Reviews of my requests (T3): one scan per interval for every repository with sources.
  const reviewing = new Set<string>();
  const reviewsTick = () => {
    const repos = folder ? folder.repos.map((r) => r.name) : [undefined];
    for (const repo of repos) {
      const c = containerFor(repo);
      if (c.isErr()) continue;
      const key = repo ?? ".";
      const container = c.value;
      if (container.resolve("config").config.reviews.sources.length === 0 || reviewing.has(key)) continue;
      reviewing.add(key);
      void container
        .resolve("myReviews")
        .scan()
        .then(async (r) => {
          const say = (o: object) =>
            process.stderr.write(`${JSON.stringify({ reviews: { repo: key, ...o } })}\n`);
          if (r.isErr()) return say({ error: r.error.message });
          for (const e of r.value.errors) say({ error: e });
          for (const q of r.value.requests) {
            if (!q.started) continue;
            say({ started: q.started, request: q.id, threads: q.fresh.length });
            await container.resolve("ensureDriven").execute({ runId: q.started });
          }
        })
        .finally(() => reviewing.delete(key));
    }
  };
  const reviewsEvery =
    opts.reviewsMs === true
      ? ctx.container().resolve("config").config.reviews.everyMs
      : (opts.reviewsMs ?? 0);
  const reviewsTimer = reviewsEvery > 0 ? setInterval(reviewsTick, reviewsEvery) : undefined;
  const intakeEvery =
    opts.intakeMs === true ? ctx.container().resolve("config").config.intake.everyMs : (opts.intakeMs ?? 0);
  const intakeTimer = intakeEvery > 0 ? setInterval(intakeTick, intakeEvery) : undefined;
  const port = server.port ?? opts.port;
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
      if (intakeTimer) clearInterval(intakeTimer);
      if (reviewsTimer) clearInterval(reviewsTimer);
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

/** A pane that steers a run or reports a heartbeat that is not its own: a change it may not make. */
const DENIED: ErrorCode = "TRANSITION_DENIED";

/** The shell of a new shell pane: the person's `terminal.shell`, else `$SHELL`, else `sh`. */
async function defaultShell(c: MetatorContainer): Promise<string> {
  const shell = await c.resolve("optionStore").get("terminal.shell");
  const configured = shell.isOk() && typeof shell.value.value === "string" ? shell.value.value : "";
  return configured !== "" ? configured : (process.env.SHELL ?? "sh");
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
      // Which of them can start on this machine: the app offers only those (D1).
      hostStatus: c.resolve("hostStatus")(),
      policy,
      sessions: c.resolve("ptyBroker").list(),
      acceptance: { since: dayAgo, ...acceptanceStats(runs, dayAgo) },
    },
  };
}
