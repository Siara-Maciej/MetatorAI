/**
 * What the app makes of the daemon's answers: a body that is not the daemon's envelope, a request
 * that never ends, a daemon that stops answering, data that is stale or not here yet, and a thing
 * a route names that the daemon does not have.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { formOffer } from "../src/features/runs/model.ts";
import { DaemonClient, readAnswer } from "../src/shared/api/api.ts";
import { pulseAfter, pulseOf } from "../src/shared/daemon/heartbeat.ts";
import { found, stateHasRun, threadsHave } from "../src/shared/model/found.ts";
import { readingOf, staleText } from "../src/shared/model/freshness.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const answering = (r: () => Response | Promise<Response>) => {
  globalThis.fetch = (async () => r()) as unknown as typeof fetch;
};

describe("an answer that is not the daemon's envelope", () => {
  test("a 500 with a text body says the status and the path, not a parser's message", async () => {
    answering(() => new Response("Internal Server Error", { status: 500 }));
    const r = await new DaemonClient("http://d").issues("shop");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("HTTP_500");
    expect(r.error?.message.startsWith("the daemon answered 500 on /issues")).toBe(true);
    expect(r.error?.message).toContain("Internal Server Error");
    expect(r.error?.message).not.toContain("JSON");
  });

  test("a refusal in the daemon's own envelope keeps its message, whatever the status", async () => {
    answering(() =>
      Response.json({ ok: false, error: { code: "NOT_FOUND", message: "no issue i9" } }, { status: 404 }),
    );
    const r = await new DaemonClient("http://d").issues();
    expect(r.error).toEqual({ code: "NOT_FOUND", message: "no issue i9" });
  });

  test("a 200 that is not JSON, and a POST's failure, name the request", async () => {
    const ok = await readAnswer(new Response("<html>"), "/issues");
    expect(ok.error?.message).toBe("the daemon's answer on /issues is not JSON");
    answering(() => new Response("", { status: 502 }));
    const r = await new DaemonClient("http://d").closeIssue("i1", "alice");
    expect(r.error?.message).toBe("the daemon answered 502 on POST /issues/i1/close");
  });

  test("a good envelope is the envelope", async () => {
    answering(() => Response.json({ ok: true, data: { issues: [] } }));
    expect(await new DaemonClient("http://d").issues()).toEqual({ ok: true, data: { issues: [] } });
  });
});

describe("a request that never ends", () => {
  test("is cut after its time and says the daemon is not answering", async () => {
    let aborted = false;
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;
    const client = new DaemonClient("http://d", { get: 20, post: 40 });
    const r = await client.issues();
    expect(aborted).toBe(true);
    expect(r.error?.code).toBe("TIMEOUT");
    expect(r.error?.message).toBe("the daemon is not answering: /issues had no answer in 0.02 s");
    const p = await client.closeIssue("i1", "alice");
    expect(p.error?.message).toContain("POST /issues/i1/close had no answer");
  });

  test("a daemon that is not there is unreachable, not silent", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const r = await new DaemonClient("http://d").issues();
    expect(r.error).toEqual({ code: "UNREACHABLE", message: "Failed to fetch" });
  });
});

describe("the daemon's pulse", () => {
  test("a pulse that times out makes the daemon silent since it was last heard; an answer brings it back", () => {
    const start = { answering: true, heardAt: undefined };
    const heard = pulseAfter(start, "answered", 1000);
    expect(heard).toEqual({ answering: true, heardAt: 1000 });
    const silent = pulseAfter(heard, "timeout", 6000);
    expect(silent).toEqual({ answering: false, heardAt: 1000 });
    // Still silent: the same object, nothing to draw.
    expect(pulseAfter(silent, "timeout", 11_000)).toBe(silent);
    expect(pulseAfter(silent, "answered", 12_000)).toEqual({ answering: true, heardAt: 12_000 });
    // Nothing at the address is the socket's business (down), not silence.
    expect(pulseAfter(heard, "unreachable", 6000)).toBe(heard);
  });

  test("what a pulse's envelope means", () => {
    expect(pulseOf({ ok: true })).toBe("answered");
    expect(pulseOf({ ok: false, error: { code: "HTTP_500", message: "x" } })).toBe("answered");
    expect(pulseOf({ ok: false, error: { code: "TIMEOUT", message: "x" } })).toBe("timeout");
    expect(pulseOf({ ok: false, error: { code: "UNREACHABLE", message: "x" } })).toBe("unreachable");
  });
});

describe("what a screen can say of its data", () => {
  test("loading and failed are not empty; stale keeps the data", () => {
    expect(readingOf({ data: undefined, error: undefined })).toBe("loading");
    expect(readingOf({ data: undefined, error: "the daemon answered 500 on /issues" })).toBe("failed");
    expect(readingOf({ data: { issues: [] }, error: "no answer" })).toBe("stale");
    expect(readingOf({ data: { issues: [] }, error: undefined })).toBe("fresh");
    expect(readingOf({ data: [], error: undefined })).toBe("fresh");
  });

  test("the stale line says since when and why", () => {
    const at = new Date(2026, 10, 25, 12, 1, 5).getTime();
    expect(staleText(at, at + 40_000, "the daemon is not answering")).toBe(
      "Not up to date: no answer since 12:01:05 (40s ago). the daemon is not answering",
    );
    expect(staleText(undefined, at, "x")).toBe("Not up to date: x");
  });
});

describe("a thing the route names", () => {
  test("is missing only when the daemon, asked after the screen opened, does not have it", () => {
    expect(found(true, undefined, 100)).toBe("found");
    expect(found(false, undefined, 100)).toBe("waiting");
    // An answer from before the screen opened (the cache's) proves nothing yet.
    expect(found(false, { data: false, updatedAt: 50 }, 100)).toBe("waiting");
    expect(found(false, { data: false, updatedAt: 150 }, 100)).toBe("missing");
    // The daemon has it: the window's state catches up.
    expect(found(false, { data: true, updatedAt: 150 }, 100)).toBe("waiting");
  });

  test("a run in the state, readable or not, in one repository or a folder; a chat open or closed", () => {
    const run = { runId: "r1" } as never;
    expect(stateHasRun({ runs: [run] } as never, "r1")).toBe(true);
    expect(stateHasRun({ runs: [], unreadable: [{ runId: "r1" }] } as never, "r1")).toBe(true);
    expect(stateHasRun({ repos: [{ name: "a", path: "/a", runs: [run] }] } as never, "r1")).toBe(true);
    expect(stateHasRun({ runs: [run] } as never, "nope")).toBe(false);
    const t = (id: string) => ({ id }) as never;
    expect(threadsHave({ threads: [t("t1")], closed: [t("t2")], withoutChat: [] }, "t2")).toBe(true);
    expect(threadsHave({ threads: [t("t1")], closed: [], withoutChat: [] }, "nope")).toBe(false);
  });
});

describe("what the new-run form offers", () => {
  test("workflows that could not be read are a refusal, not an empty list", () => {
    const refused = formOffer(
      { ok: false, error: { code: "HTTP_500", message: "the daemon answered 500 on /workflows" } },
      { ok: true },
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toBe(
      "The workflows could not be read: the daemon answered 500 on /workflows",
    );
    const offered = formOffer({ ok: true, data: { workflows: [] } }, { ok: false });
    expect(offered).toEqual({ ok: true, data: { workflows: [], supervisor: undefined } });
  });
});
