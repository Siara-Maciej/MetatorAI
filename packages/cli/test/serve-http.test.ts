import { describe, expect, test } from "bun:test";
import { err, MetatorError, ok } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { z } from "zod";
import {
  body,
  type Daemon,
  denied,
  dispatcher,
  flag,
  optional,
  type Route,
  route,
  strings,
  text,
} from "../src/serve/http.ts";
import { ROUTES } from "../src/serve/server.ts";

const daemon = {
  folder: null,
  startedAt: 0,
  hostname: "127.0.0.1",
  superviseMs: 0,
  port: () => 1,
  state: async () => ok({ runs: [] }),
  inbox: async () => ok({ decisions: [] }),
  repos: () => [],
} satisfies Daemon;

const container = { name: "the container" } as unknown as MetatorContainer;
const seen: unknown[] = [];
const routes: readonly Route[] = [
  route({ method: "GET", pattern: "/things", handler: ({ query }) => ok({ since: query.get("since") }) }),
  route({ method: "GET", pattern: "/state", global: true, handler: ({ daemon: d }) => d.state(true) }),
  route({
    method: "POST",
    pattern: "/things/:thing/rename",
    body: body({ name: text, tags: strings, loud: flag, kind: optional(z.enum(["a", "b"])) }),
    handler: ({ c, params, body: b }) => {
      seen.push({ c, params, body: b });
      return { result: ok({ renamed: params.thing, to: b.name ?? "" }), warnings: ["watch out"] };
    },
  }),
  route({
    method: "POST",
    pattern: "/options/:key+",
    handler: ({ params }) => ok({ key: params.key }),
  }),
  route({
    method: "GET",
    pattern: "/things/:thing",
    handler: ({ params }) =>
      params.thing === "gone"
        ? err(MetatorError.notFound(`thing ${params.thing}`))
        : ok({ id: params.thing }),
  }),
  route({
    method: "POST",
    pattern: "/things/:thing/steer",
    guard: async ({ token }) =>
      token === "own" ? undefined : denied("only the thing steers itself", "Ask it."),
    handler: () => ok({ steered: true }),
  }),
  route({
    method: "PUT",
    pattern: "/things/:thing",
    body: body({ name: text }),
    handler: ({ params, body: b }) => ok({ replaced: params.thing, name: b.name ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/things/:thing/save",
    handler: () =>
      err(
        new MetatorError("CONFLICT", "the thing changed since you read it", {
          details: { current: { v: 2 } },
        }),
      ),
  }),
  route({
    method: "POST",
    pattern: "/things/:thing/break",
    handler: () => err(MetatorError.usage("that cannot be done")),
  }),
  route({
    method: "GET",
    pattern: "/things/:thing/wait",
    longPoll: true,
    handler: () => ok({ waited: true }),
  }),
];

const call = async (
  method: string,
  path: string,
  init: {
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    unknownRepo?: boolean;
    untimed?: (req: Request) => void;
  } = {},
) => {
  const dispatch = dispatcher(routes, {
    daemon,
    ...(init.untimed ? { untimed: init.untimed } : {}),
    containerFor: () =>
      init.unknownRepo ? err({ code: "NOT_FOUND", message: "repository x is not in /work" }) : ok(container),
  });
  const url = new URL(`http://localhost${path}`);
  const r = await dispatch(
    new Request(url, {
      method,
      ...(init.headers ? { headers: init.headers } : {}),
      ...(method === "POST" || method === "PUT" ? { body: init.raw ?? JSON.stringify(init.body ?? {}) } : {}),
    }),
    url,
    url.pathname,
  );
  return {
    status: r.status,
    json: (await r.json()) as Record<string, unknown>,
    cors: r.headers.get("access-control-allow-origin"),
  };
};

describe("the daemon's dispatcher", () => {
  test("the first route whose method and pattern fit answers, with the envelope and CORS", async () => {
    expect(await call("GET", "/things?since=x")).toEqual({
      status: 200,
      json: { ok: true, data: { since: "x" } },
      cors: "*",
    });
    expect((await call("GET", "/things/a%20b")).json).toEqual({ ok: true, data: { id: "a b" } });
    // PUT replaces a document: its body is read and checked like a POST's.
    expect((await call("PUT", "/things/t1", { body: { name: "new" } })).json).toEqual({
      ok: true,
      data: { replaced: "t1", name: "new" },
    });
    expect((await call("PUT", "/things/t1", { body: { name: 7 } })).status).toBe(400);
    // `:name+` takes the rest of the path, slashes too.
    expect((await call("POST", "/options/ui.pane/borders")).json).toEqual({
      ok: true,
      data: { key: "ui.pane/borders" },
    });
  });

  test("no route, or the wrong method for one, is NOT_FOUND with 404", async () => {
    for (const [method, path] of [
      ["GET", "/nothing"],
      ["POST", "/things"],
      ["GET", "/things/a/rename"],
    ] as const) {
      const r = await call(method, path);
      expect([r.status, r.json]).toEqual([
        404,
        { ok: false, error: { code: "NOT_FOUND", message: `no route ${method} ${path}` } },
      ]);
    }
  });

  test("a body is checked against the route's schema before the handler runs: what does not fit is USAGE with 400", async () => {
    seen.length = 0;
    const bad = await call("POST", "/things/t1/rename", { body: { name: 7, tags: "x", kind: "c" } });
    expect([bad.status, (bad.json.error as { code: string }).code, seen]).toEqual([400, "USAGE", []]);
    const message = (bad.json.error as { message: string }).message;
    expect(message).toStartWith("the request's body does not fit POST /things/:thing/rename: ");
    for (const field of ["name: ", "tags: ", "kind: "]) expect(message).toContain(field);
  });

  test("a field left out, null or empty is not given; what else the body carries is ignored; warnings go out", async () => {
    seen.length = 0;
    const r = await call("POST", "/things/t1/rename", {
      body: { name: "", tags: null, kind: "", loud: true, somethingNewer: { a: 1 } },
    });
    expect([r.status, r.json]).toEqual([
      200,
      { ok: true, data: { renamed: "t1", to: "" }, warnings: ["watch out"] },
    ]);
    expect((seen[0] as { c: unknown; params: unknown }).c).toBe(container);
    expect((seen[0] as { body: Record<string, unknown> }).body).toMatchObject({ name: "", loud: true });
    expect((seen[0] as { body: Record<string, unknown> }).body.kind).toBeUndefined();
    // A body that is no JSON object is an empty one.
    for (const raw of ["not json", "[1,2]", "null"])
      expect((await call("POST", "/things/t1/rename", { raw })).status).toBe(200);
  });

  test("statuses: what is not there 404, a stale write 409, what the caller may not do 403 (the handler does not run), the rest 400", async () => {
    const gone = await call("GET", "/things/gone");
    expect([gone.status, (gone.json.error as { code: string }).code]).toEqual([404, "NOT_FOUND"]);
    const refused = await call("POST", "/things/t1/steer", { headers: { "x-metator-pane": "other" } });
    expect([refused.status, refused.json]).toEqual([
      403,
      {
        ok: false,
        error: { code: "TRANSITION_DENIED", message: "only the thing steers itself", hint: "Ask it." },
      },
    ]);
    const own = await call("POST", "/things/t1/steer", { headers: { "x-metator-pane": "own" } });
    expect([own.status, own.json]).toEqual([200, { ok: true, data: { steered: true } }]);
    const stale = await call("POST", "/things/t1/save");
    expect([stale.status, stale.json]).toEqual([
      409,
      {
        ok: false,
        error: {
          code: "CONFLICT",
          message: "the thing changed since you read it",
          details: { current: { v: 2 } },
        },
      },
    ]);
    const usage = await call("POST", "/things/t1/break");
    expect([usage.status, (usage.json.error as { code: string }).code]).toEqual([400, "USAGE"]);
  });

  test("a repository the daemon does not serve is 404 for a route that needs it; a global route answers anyway", async () => {
    const r = await call("GET", "/things", { unknownRepo: true });
    expect([r.status, r.json]).toEqual([
      404,
      { ok: false, error: { code: "NOT_FOUND", message: "repository x is not in /work" } },
    ]);
    expect((await call("GET", "/state", { unknownRepo: true })).json).toEqual({
      ok: true,
      data: { runs: [] },
    });
  });
});

describe("which repository a call is for (a daemon serving a folder)", () => {
  const whoami = route({
    method: "GET",
    pattern: "/whoami",
    handler: ({ repo }) => ok({ repo: repo ?? null }),
  });
  const ask = async (path: string, headers: Record<string, string> = {}) => {
    const asked: (string | undefined)[] = [];
    const dispatch = dispatcher([whoami], {
      daemon,
      containerFor: (repo) => {
        asked.push(repo);
        return ok(container);
      },
      repoOfToken: async (token) => (token === "pane-of-web" ? "shop-web" : undefined),
    });
    const url = new URL(`http://localhost${path}`);
    const r = await dispatch(new Request(url, { headers }), url, url.pathname);
    return { json: (await r.json()) as { data: { repo: string | null } }, asked };
  };

  test("the repository the call names wins; else the one the pane's token belongs to; else none", async () => {
    expect((await ask("/whoami?repo=shop-api", { "x-metator-pane": "pane-of-web" })).json.data.repo).toBe(
      "shop-api",
    );
    const fromPane = await ask("/whoami", { "x-metator-pane": "pane-of-web" });
    expect([fromPane.json.data.repo, fromPane.asked]).toEqual(["shop-web", ["shop-web"]]);
    expect((await ask("/whoami", { "x-metator-pane": "unknown" })).json.data.repo).toBeNull();
    expect((await ask("/whoami")).json.data.repo).toBeNull();
  });
});

describe("the daemon's route table", () => {
  test("a long poll is not cut off by the server's idle timeout; any other request is", async () => {
    const lifted: string[] = [];
    const untimed = (req: Request) => lifted.push(new URL(req.url).pathname);
    expect((await call("GET", "/things/a/wait", { untimed })).json).toEqual({
      ok: true,
      data: { waited: true },
    });
    await call("GET", "/things/a", { untimed });
    expect(lifted).toEqual(["/things/a/wait"]);
    // The daemon's own waits are long polls: a worker may work for minutes.
    expect(ROUTES.filter((r) => r.longPoll).map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "GET /panes/:pane/wait",
      "GET /runs/:run/wait",
    ]);
  });

  test("no two routes answer the same method and pattern; every POST with fields has a schema", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.pattern}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
    expect(ROUTES.length).toBeGreaterThan(55);
    // The routes without a body's schema take no fields at all.
    expect(
      ROUTES.filter((r) => r.method === "POST" && !r.body)
        .map((r) => r.pattern)
        .sort(),
    ).toEqual([
      "/panes/:pane/close",
      "/panes/:pane/heartbeat",
      "/runs/:run/close-panes",
      "/runs/:run/pty-close",
      "/runs/:run/release",
      "/runs/:run/seen",
      "/runs/:run/stop",
      "/workspaces/:workspace/close",
    ]);
  });

  test("the paths the desktop app and the CLI call are all there", () => {
    const keys = new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`));
    for (const k of [
      "GET /state",
      "GET /inbox",
      "GET /conflicts",
      "GET /workflows",
      "GET /report",
      "GET /supervisor",
      "GET /layout",
      "GET /options",
      "GET /options/schema",
      "POST /options/:key+",
      "GET /issues",
      "POST /issues",
      "POST /issues/:issue/decide",
      "POST /issues/:issue/edit",
      "POST /issues/:issue/close",
      "POST /issues/:issue/drop",
      "POST /issues/:issue/start",
      "GET /mrs",
      "GET /mrs/:request",
      "POST /mrs/:request/send",
      "POST /mrs/:request/resolve",
      "POST /panes",
      "GET /panes/:pane",
      "GET /panes/:pane/wait",
      "GET /panes/:pane/state",
      "POST /panes/:pane/close",
      "POST /panes/close-ended",
      "POST /panes/:pane/started-run",
      "POST /panes/:pane/open-editor",
      "POST /panes/:pane/split",
      "POST /panes/:pane/heartbeat",
      "POST /tabs/:tab/tree",
      "POST /workspaces/:workspace/close",
      "POST /runs",
      "POST /runs/:run/start",
      "POST /runs/:run/delegate",
      "GET /runs/:run/workers",
      "GET /runs/:run/wait",
      "POST /runs/:run/collect",
      "POST /runs/:run/open-editor",
      "GET /runs/:run/review",
      "GET /runs/:run/review-notes",
      "POST /runs/:run/review-notes",
      "POST /runs/:run/review-send",
      "POST /runs/:run/review-note-status",
      "GET /runs/:run/board",
      "GET /runs/:run/activity",
      "GET /runs/:run/brief",
      "POST /runs/:run/seen",
      "GET /runs/:run/messages",
      "GET /runs/:run/pty",
      "POST /runs/:run/attach",
      "POST /runs/:run/release",
      "POST /runs/:run/answer",
      "POST /panes/:pane/answer",
      "POST /panes/:pane/continue",
      "POST /runs/:run/approve",
      "POST /runs/:run/resume",
      "POST /runs/:run/stop",
      "POST /runs/:run/close",
      "POST /runs/:run/message",
      "POST /runs/:run/pty-open",
      "POST /runs/:run/close-panes",
      "POST /runs/:run/pty-close",
      "POST /runs/:run/drive",
      "POST /runs/:run/continue",
      "GET /runs/:run/plan",
      "POST /runs/:run/plan/lint",
      "GET /system/plans",
      "GET /system/plans/:plan",
      "POST /system/plans/:plan/lint",
      "POST /system/plans/:plan/approve",
      "POST /system/plans/:plan/steps/:step/retry",
      "GET /system/map",
      "PUT /system/map",
      "POST /system/discover",
      "GET /runs/:run/artifacts",
      "GET /runs/:run/artifacts/:name+",
      "GET /scratch",
      "POST /scratch/drop",
    ])
      expect([k, keys.has(k)]).toEqual([k, true]);
    expect(keys.size).toBe(80);
  });
});
