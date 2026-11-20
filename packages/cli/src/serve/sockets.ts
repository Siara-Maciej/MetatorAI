import { err, MetatorError, ok, type PtyEvent, type PtyView, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { toEnvelope } from "@metator/runtime";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";

/** When a line typed in a pane is looked at: after its echo, and once more for a slow host. */
const ANSWER_LOOK_MS = [150, 600] as const;
/**
 * The daemon's WebSockets (D3): `/ws/state` and `/ws/inbox` send the overview when it changes,
 * `/ws/activity/<run>` streams a run's activity, `/ws/pty/<run>` and `/ws/pane/<pane>` are a
 * terminal: output out, input and resizes in.
 */
export interface Socket {
  readonly kind: "state" | "inbox" | "activity" | "pty" | "pane";
  readonly repo: string | undefined;
  readonly runId?: string | undefined;
  /** The pane a `pty` or `pane` socket streams; set once the pane is known. */
  paneId?: string | undefined;
  readonly by?: string | undefined;
  stop?: () => void;
  /** Resolves once a `pty` or `pane` socket has found its pane: input waits for it. */
  ready?: Promise<void>;
  /** The pane's work is over: its last screen is shown, nothing is typed into it. */
  ended?: { readonly reason: string } | undefined;
}

export interface SocketDeps {
  readonly pollMs: number;
  readonly containerFor: (
    repo: string | undefined,
  ) => Result<MetatorContainer, { readonly code: string; readonly message: string }>;
  readonly state: (fresh: boolean) => Promise<Result<unknown, MetatorError>>;
  readonly inbox: (fresh: boolean) => Promise<Result<unknown, MetatorError>>;
}

/** The socket a path names, upgraded; undefined when the path is no socket's. */
export function upgrade(
  req: Request,
  server: Server<Socket>,
  url: URL,
  path: string,
): { readonly upgraded: boolean } | undefined {
  const repo = url.searchParams.get("repo") ?? undefined;
  if (path === "/ws/state" || path === "/ws/inbox") {
    const kind = path === "/ws/state" ? "state" : "inbox";
    return { upgraded: server.upgrade(req, { data: { kind, repo } }) };
  }
  const ws = /^\/ws\/(activity|pty|pane)\/([^/]+)$/.exec(path);
  if (!ws) return undefined;
  const kind = ws[1] as "activity" | "pty" | "pane";
  const data: Socket = {
    kind,
    repo,
    ...(kind === "pane" ? { paneId: decodeURIComponent(ws[2] as string) } : { runId: ws[2] as string }),
    by: url.searchParams.get("by") ?? undefined,
  };
  return { upgraded: server.upgrade(req, { data }) };
}

export function socketHandlers(
  { pollMs, containerFor, state, inbox }: SocketDeps,
  sockets: Set<ServerWebSocket<Socket>>,
): WebSocketHandler<Socket> {
  return {
    async open(ws) {
      sockets.add(ws);
      const d = ws.data;
      if (d.kind === "state" || d.kind === "inbox") {
        let last = "";
        const tick = async () => {
          const text = JSON.stringify(
            toEnvelope(d.kind === "state" ? await state(false) : await inbox(false)),
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
      // Input can arrive before the pane is found: `message` waits for this open to finish.
      let ready: () => void = () => {};
      d.ready = new Promise<void>((resolve) => {
        ready = resolve;
      });
      // A pane's socket needs a live pane. A run's socket finds the session the run already has
      // (a reconnect): it never starts one. Starting is the explicit `POST /runs/<id>/pty-open`.
      // An ended pane: its last screen, read-only, until a person closes it.
      if (d.kind === "pane") {
        const found = await panes.pane(d.paneId as string);
        if (found.isOk() && found.value.ended) {
          d.paneId = found.value.id;
          d.ended = { reason: found.value.ended.reason };
          ready();
          ws.send(JSON.stringify({ type: "ended", ended: found.value.ended }));
          const screen = await panes.keptScreen(found.value.id);
          if (screen) ws.send(JSON.stringify({ type: "data", data: screen }));
          return;
        }
      }
      const session = d.kind === "pty" ? broker.byRun(runId)[0] : undefined;
      const opened: Result<PtyView, MetatorError> =
        d.kind === "pane"
          ? (await panes.pane(d.paneId as string)).andThen((p) =>
              p.live ? ok(p.live) : err(MetatorError.notFound(`a terminal in pane ${d.paneId}`)),
            )
          : session
            ? ok(session)
            : err(
                new MetatorError("NOT_FOUND", `run ${runId} has no terminal session`, {
                  hint: `Start one first: POST /runs/${runId}/pty-open (\`metator run start --run ${runId}\`).`,
                }),
              );
      if (opened.isErr()) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: {
              code: opened.error.code,
              message: opened.error.message,
              ...(opened.error.hint ? { hint: opened.error.hint } : {}),
            },
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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        ws.send(
          JSON.stringify({
            type: "refused",
            reason: "messages are JSON: {type: input, data} or {type: resize, cols, rows}",
          }),
        );
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string" && d.ended) {
        ws.send(
          JSON.stringify({
            type: "refused",
            reason: `pane ${d.paneId} has ended (${d.ended.reason}): its screen is read-only; close it when you are done (POST /panes/${d.paneId}/close)`,
          }),
        );
      } else if (msg.type === "input" && typeof msg.data === "string") {
        const r = await broker.write({ paneId: d.paneId, data: msg.data, by: d.by ?? "" });
        if (r.isErr()) ws.send(JSON.stringify({ type: "refused", reason: r.error.message }));
        // A line typed in a pane may answer its question: looked at as soon as the pane has
        // echoed it, not on the daemon's next check, so its card goes and the answer is recorded.
        else if (/[\r\n]/.test(msg.data)) {
          const prompts = c.value.resolve("hostPrompts");
          for (const ms of ANSWER_LOOK_MS) setTimeout(() => void prompts.tick(), ms);
        }
      } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        broker.resize(d.paneId, { cols: msg.cols, rows: msg.rows });
      }
    },
    close(ws) {
      ws.data.stop?.();
      sockets.delete(ws);
    },
  };
}
