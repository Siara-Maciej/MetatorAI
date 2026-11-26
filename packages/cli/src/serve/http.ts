import { err, MetatorError, type Overview, type Result } from "@metator/core";
import { type MetatorContainer, toEnvelope } from "@metator/runtime";
import { z } from "zod";
import type { Folder } from "../context.ts";

/**
 * The daemon's HTTP surface as data (D3, ADR-0077): each route is `{method, pattern, body,
 * handler}`, and one dispatcher does what every route needs: the repository's container, the
 * body checked against its schema, the answer as MetatorAI's envelope with the status that goes
 * with it. A handler only calls a use case and shapes its data.
 */

/**
 * The app is another origin (Tauri's webview, or a browser next to the daemon), so every answer
 * says any origin may read it: the daemon listens on localhost only and has no secrets to guard
 * beyond what every local process can read anyway (decision 1).
 */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

/**
 * The HTTP status of an error: what is not there is 404, a write on a stale digest 409 (the
 * document changed since it was read), what the caller may not do 403, the rest 400.
 */
function statusOf(error: MetatorError, forbidden = false): number {
  if (forbidden) return 403;
  if (error.code === "CONFLICT") return 409;
  return error.code === "NOT_FOUND" ? 404 : 400;
}

/** A result as the envelope every command prints, with the status that goes with it. */
function respond(
  result: Result<unknown, MetatorError>,
  { warnings = [], forbidden = false }: { warnings?: readonly string[]; forbidden?: boolean } = {},
): Response {
  return json(toEnvelope(result, warnings), result.isOk() ? 200 : statusOf(result.error, forbidden));
}

/** What a handler knows of the daemon it runs in. */
export interface Daemon {
  readonly folder: Folder | null;
  readonly startedAt: number;
  readonly hostname: string;
  readonly superviseMs: number;
  /** The port the daemon is bound to: with `--port 0` that is not the one it was asked for. */
  port(): number;
  /** The same overview `metator status` prints: one repository, or each repository of a folder. */
  state(fresh: boolean): Promise<Result<unknown, MetatorError>>;
  /** The same queue `metator inbox` prints. */
  inbox(fresh: boolean): Promise<Result<unknown, MetatorError>>;
  /** Every repository the daemon serves, with its container (the one its panes live in); a name in a folder. */
  repos(): readonly { readonly name?: string; readonly c: MetatorContainer }[];
  /** Each repository's overview as the state socket read it last (the same one, not read twice a tick). */
  overviews(fresh: boolean): Promise<
    readonly {
      readonly name?: string;
      readonly c: MetatorContainer;
      readonly overview: Result<Overview, MetatorError>;
    }[]
  >;
}

export interface Call<B = unknown> {
  /** The container of the repository the request names (`?repo=`), or of the only one. */
  readonly c: MetatorContainer;
  /** The pattern's `:names`, decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: B;
  /** The pane the call comes from, when it carries a pane's token (`x-metator-pane`). */
  readonly token: string | null;
  readonly repo: string | undefined;
  readonly daemon: Daemon;
}

type Answer =
  | Result<unknown, MetatorError>
  | { readonly result: Result<unknown, MetatorError>; readonly warnings?: readonly string[] };

export interface Route<B = unknown> {
  /** PUT replaces a document a person edits (ADR-0087); POST does everything else that changes. */
  readonly method: "GET" | "POST" | "PUT";
  /** `/runs/:run/answer`; `:name` is one segment, `:name+` the rest of the path. */
  readonly pattern: string;
  /** The body's schema (POST, PUT): what does not fit it is a usage error, before the handler runs. */
  readonly body?: z.ZodType<B>;
  /** Answers for every repository at once: it needs no container of its own. */
  readonly global?: true;
  /**
   * Answers when what it waits for happens (a worker reports, a pane goes idle), which can be
   * minutes: the server's idle timeout does not cut it off.
   */
  readonly longPoll?: true;
  /** Who may call: an error here is 403, and the handler does not run. */
  readonly guard?: (call: Call<B>) => Promise<MetatorError | undefined>;
  readonly handler: (call: Call<B>) => Promise<Answer> | Answer;
}

/** A route with its body's type kept for the handler and forgotten for the table. */
export const route = <B>(r: Route<B>): Route => r as unknown as Route;

/** A pane that steers a run or reports a heartbeat that is not its own: a change it may not make. */
export const denied = (message: string, hint?: string) =>
  new MetatorError("TRANSITION_DENIED", message, hint ? { hint } : {});

/** An optional field: left out, `null` and an empty string all mean "not given". */
export const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

/** A text field that may be empty (a use case says what is wrong with an empty name). */
export const text = z.preprocess((v) => (v === null ? undefined : v), z.string().optional());

export const flag = z.preprocess((v) => (v === null ? undefined : v), z.boolean().optional());
export const count = optional(z.number());
export const strings = optional(z.array(z.string()));

/** A body with these fields; what else it carries is ignored, as an older or newer client sends it. */
export const body = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape);

interface Compiled {
  readonly route: Route;
  readonly match: (path: string) => Record<string, string> | undefined;
}

function compile(r: Route): Compiled {
  const names: string[] = [];
  const source = r.pattern
    .split("/")
    .map((part) => {
      if (!part.startsWith(":")) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rest = part.endsWith("+");
      names.push(part.slice(1, rest ? -1 : undefined));
      return rest ? "(.+)" : "([^/]+)";
    })
    .join("/");
  const pattern = new RegExp(`^${source}$`);
  return {
    route: r,
    match: (path) => {
      const m = pattern.exec(path);
      if (!m) return undefined;
      const params: Record<string, string> = {};
      try {
        names.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] as string);
        });
      } catch {
        return undefined; // a path that is not a URL path names no route
      }
      return params;
    },
  };
}

export interface Dispatch {
  readonly daemon: Daemon;
  /**
   * In a folder: the repository a pane's token belongs to, when a call names none (a conductor's
   * or a worker's command, run in that repository). Undefined: none of them knows the token.
   */
  readonly repoOfToken?: (token: string) => Promise<string | undefined>;
  readonly containerFor: (
    repo: string | undefined,
  ) => Result<MetatorContainer, { readonly code: string; readonly message: string }>;
  /** Lifts the server's idle timeout for one request: a long poll's. */
  readonly untimed?: (req: Request) => void;
  /** Told of every request that is not a GET once its handler answered (the event channel, ADR-0110). */
  readonly answered?: (route: Route, call: Call) => void;
}

/** What is wrong with a body, as one line a person can act on: `by: expected string`. */
function problems(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("; ");
}

/**
 * The routes as one function from a request to its answer: the first route whose method and
 * pattern fit; its repository; its body, read and checked; its guard; its handler's result as
 * the envelope. No route is NOT_FOUND (404), a body that does not fit USAGE (400).
 */
export function dispatcher(
  routes: readonly Route[],
  { daemon, containerFor, repoOfToken, untimed, answered }: Dispatch,
) {
  const table = routes.map(compile);
  return async (req: Request, url: URL, path: string): Promise<Response> => {
    let found: { route: Route; params: Record<string, string> } | undefined;
    for (const entry of table) {
      if (entry.route.method !== req.method) continue;
      const params = entry.match(path);
      if (params) {
        found = { route: entry.route, params };
        break;
      }
    }
    if (!found) return respond(err(new MetatorError("NOT_FOUND", `no route ${req.method} ${path}`)));
    if (found.route.longPoll) untimed?.(req);
    const token = req.headers.get("x-metator-pane");
    const repo =
      url.searchParams.get("repo") ??
      (token && repoOfToken ? await repoOfToken(token) : undefined) ??
      undefined;
    const c = containerFor(found.route.global ? undefined : repo);
    // A global route reads every repository through the daemon; it is given the first container.
    if (c.isErr()) {
      if (!found.route.global) return json({ ok: false, error: c.error }, 404);
    }
    let parsed: unknown = {};
    if (req.method === "POST" || req.method === "PUT") {
      const raw = (await req.json().catch(() => ({}))) as unknown;
      const given = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      if (found.route.body) {
        const checked = found.route.body.safeParse(given);
        if (!checked.success)
          return respond(
            err(
              MetatorError.usage(
                `the request's body does not fit ${req.method} ${found.route.pattern}: ${problems(checked.error)}`,
              ),
            ),
          );
        parsed = checked.data;
      } else parsed = given;
    }
    const call: Call = {
      c: (c.isOk() ? c.value : undefined) as MetatorContainer,
      params: found.params,
      query: url.searchParams,
      body: parsed,
      token,
      repo,
      daemon,
    };
    const refused = await found.route.guard?.(call);
    if (refused) return respond(err(refused), { forbidden: true });
    const answer = await found.route.handler(call);
    // Even a refusal may have changed something on its way (a pane opened, then a step failed).
    if (req.method !== "GET") answered?.(found.route, call);
    return "result" in answer
      ? respond(answer.result, answer.warnings ? { warnings: answer.warnings } : {})
      : respond(answer);
  };
}
