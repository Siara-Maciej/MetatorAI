import { expect, test } from "bun:test";
import { join } from "node:path";
import { WaitOnHealthProbe } from "../src/wait-on-health-probe.ts";

test("wait-on is loaded by the first probe, not by the import: commands that probe nothing do not pay for it", async () => {
  const main = join(import.meta.dir, "../src/wait-on-health-probe.ts");
  const script = `
    const { WaitOnHealthProbe } = await import(${JSON.stringify(main)});
    const loaded = () => Object.keys(require.cache).some((k) => k.includes("/wait-on/"));
    const before = loaded();
    await new WaitOnHealthProbe().waitFor({ tcp: { host: "127.0.0.1", port: 1 } }, 1);
    console.log(JSON.stringify([before, loaded()]));`;
  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: import.meta.dir });
  expect(proc.stdout.toString().trim()).toBe("[false,true]");
});

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
