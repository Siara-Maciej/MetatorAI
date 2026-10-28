import { expect, test } from "bun:test";
import { WaitOnHealthProbe } from "../src/wait-on-health-probe.ts";

test("TCP: ready once something listens", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const r = await new WaitOnHealthProbe().waitFor({ tcp: { host: "127.0.0.1", port: server.port } }, 5_000);
    expect(r.isOk()).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("HTTP: ready on a 2xx answer to GET, even when HEAD is not answered", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => (req.method === "GET" ? new Response("ok") : new Response("no", { status: 405 })),
  });
  try {
    const r = await new WaitOnHealthProbe().waitFor(
      { http: `http://127.0.0.1:${server.port}/health` },
      5_000,
    );
    expect(r.isOk()).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("nothing listening: an error value after the timeout", async () => {
  const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = free.port;
  free.stop(true);
  const r = await new WaitOnHealthProbe().waitFor({ tcp: { host: "127.0.0.1", port } }, 600);
  expect(r._unsafeUnwrapErr().message).toContain(`tcp:127.0.0.1:${port} was not ready`);
});
