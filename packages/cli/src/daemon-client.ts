import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAEMON_FILE,
  type DaemonInfo,
  DaemonInfoDocument,
  err,
  MetatorError,
  ok,
  parseJsonDocument,
  type Result,
} from "@metator/core";

/** The daemon this directory's repository (or folder) belongs to, from `.metator/daemon.json`. */
export function findDaemon(start: string): Result<DaemonInfo, MetatorError> {
  let dir = start;
  for (;;) {
    const file = join(dir, DAEMON_FILE);
    if (existsSync(file)) {
      const raw = parseJsonDocument(readFileSync(file, "utf8"), file);
      if (raw.isErr()) return err(raw.error);
      const info = DaemonInfoDocument.parse(raw.value, file);
      if (info.isErr()) return err(info.error);
      if (!processLives(info.value.pid))
        return err(
          new MetatorError("NOT_FOUND", `the daemon (pid ${info.value.pid}) is gone; its file is stale`, {
            hint: "Start it again: `metator serve`.",
          }),
        );
      return ok(info.value);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return err(
    new MetatorError("NOT_FOUND", "no daemon runs for this repository", {
      hint: "Start it with `metator serve` (it writes .metator/daemon.json).",
    }),
  );
}

/** The daemon `<root>/.metator/daemon.json` names, when its process lives; a stale or unreadable file names none. */
export function liveDaemonAt(root: string): DaemonInfo | undefined {
  const file = join(root, DAEMON_FILE);
  if (!existsSync(file)) return undefined;
  const info = parseJsonDocument(readFileSync(file, "utf8"), file).andThen((raw) =>
    DaemonInfoDocument.parse(raw, file),
  );
  return info.isOk() && processLives(info.value.pid) ? info.value : undefined;
}

/**
 * Inside the sandbox a host session starts in (ADR-0104): the daemon's process is in another PID
 * namespace, out of sight, and the network is reached only through the sandbox's proxy, which
 * lets the daemon's own address through.
 */
export const inSandbox = (env: Readonly<Record<string, string | undefined>> = process.env): boolean =>
  env.METATOR_SANDBOX === "1";

/**
 * How a call reaches the daemon: directly, or inside the sandbox through its proxy. The proxy
 * holds the only way out of the sandbox; the exceptions it is told to skip (`NO_PROXY` names the
 * loopback) would lead nowhere there, so they are dropped.
 */
export function daemonRoute(env: Record<string, string | undefined> = process.env): { proxy?: string } {
  const proxy = inSandbox(env) ? (env.HTTP_PROXY ?? env.http_proxy) : undefined;
  if (!proxy) return {};
  delete env.NO_PROXY;
  delete env.no_proxy;
  return { proxy };
}

function processLives(pid: number): boolean {
  if (inSandbox()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One JSON call to the daemon, its envelope unwrapped into a Result. */
export async function callDaemon<T>(
  daemon: DaemonInfo,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs?: number,
): Promise<Result<T, MetatorError>> {
  let response: Response;
  try {
    response = await fetch(`${daemon.url}${path}`, {
      ...daemonRoute(),
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (e) {
    return err(
      new MetatorError(
        "COMMAND_FAILED",
        `the daemon at ${daemon.url} does not answer: ${(e as Error).message}`,
      ),
    );
  }
  const envelope = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
  };
  if (envelope.ok && envelope.data !== undefined) return ok(envelope.data);
  const e = envelope.error ?? {};
  return err(
    new MetatorError(
      (e.code as "COMMAND_FAILED") ?? "COMMAND_FAILED",
      e.message ?? `HTTP ${response.status}`,
      {
        ...(e.hint ? { hint: e.hint } : {}),
        // What the daemon gave with its refusal (the live sessions, say) reaches the caller too.
        ...(e.details ? { details: e.details } : {}),
      },
    ),
  );
}

/** The pane this process runs in, when the daemon started it (its identity for the daemon's API). */
export const paneHeaders = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => (env.METATOR_PANE_TOKEN ? { "x-metator-pane": env.METATOR_PANE_TOKEN } : {});

/**
 * A daemon path for the repository at `root`: a daemon that serves a folder takes the repository
 * by its root (`?repo=`), so a command run in the folder's second repository reaches that one.
 */
export function inRepo(path: string, root: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}repo=${encodeURIComponent(root)}`;
}
