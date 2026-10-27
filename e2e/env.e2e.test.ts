/**
 * `env *` end to end (F8.5): the real `metator` discovers how a repository starts and runs its
 * services as real processes, per worktree on the worktree's ports, sharing the "database";
 * compose services go through a stand-in `docker` that records what it was asked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

interface Svc {
  service: string;
  place: string;
  status: string;
  ports: Record<string, number>;
  pid?: number;
}

const freePort = () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
};

let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const services = async (...args: string[]) => ((await mt(...args)).json.data as { services: Svc[] }).services;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  const dbPort = freePort();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { dev: "bun server.ts --port 3000" } }),
  );
  await repo.write(
    "db.ts",
    'Bun.listen({ hostname: "0.0.0.0", port: Number(process.env.PORT), socket: { data() {} } });\n',
  );
  await repo.write(
    "server.ts",
    [
      "Bun.serve({ port: Number(process.env.PORT), fetch: () =>",
      '  new Response([process.env.METATOR_WORKTREE ?? "main", process.env.DATABASE_URL].join(" ")) });',
      'console.log("api on " + process.env.PORT);',
      "",
    ].join("\n"),
  );
  await repo.write("never.ts", "setInterval(() => {}, 1000);\nconsole.log('starting forever');\n");
  await repo.write(
    "metator/environment.yml",
    `kind: Environment
schemaVersion: 1
services:
  db:
    source: { script: "bun db.ts" }
    scope: shared
    ports: { pg: ${dbPort} }
    health: { tcp: pg }
  api:
    source: { script: "bun server.ts" }
    needs: [db]
    ports: { http: ${freePort()} }
    health: { http: /health }
    env: { DATABASE_URL: "postgres://127.0.0.1:{port:db.pg}/shop" }
  stuck:
    source: { script: "bun never.ts" }
    scope: on-demand
    ports: { http: ${freePort()} }
    health: { http: / }
    readyTimeoutMs: 800
  cache:
    source: { compose: { file: compose.yml, service: cache } }
    scope: on-demand
`,
  );
  await repo.write(
    "docker",
    '#!/bin/sh\necho "$*" >> docker-calls.txt\necho "cache-1 | Ready to accept connections"\n',
  );
  await chmod(repo.path("docker"), 0o755);
  await repo.commit("init");
  env = { METATOR_DOCKER_BIN: repo.path("docker") };
});
afterAll(async () => {
  for (const wt of ["one", "two"]) await mt("env", "down", "--worktree", wt, "--shared");
  await mt("env", "down", "--shared");
  await repo.dispose();
});

describe("metator env (real CLI, real processes)", () => {
  test("discover proposes services with evidence; init refuses to overwrite a written environment", async () => {
    const d = await mt("env", "discover");
    const data = d.json.data as {
      environment: { services: Record<string, { ports: Record<string, number> }> };
      evidence: { from: string }[];
    };
    expect(data.environment.services.app?.ports).toEqual({ http: 3000 });
    expect(data.evidence.map((e) => e.from)).toEqual(["package.json#scripts.dev"]);
    const init = await mt("env", "init");
    expect([init.code, (init.json.error as { message: string }).message]).toEqual([
      64,
      "metator/environment.yml already exists",
    ]);
    expect((await mt("env", "init", "--dry-run")).code).toBe(0);
    const schema = (await mt("env", "schema")).json.data as { properties: { kind: { const: string } } };
    expect(schema.properties.kind.const).toBe("Environment");
  }, 30_000);

  test("two worktrees run their own api on their own ports and share one database", async () => {
    await mt("worktree", "new", "one");
    await mt("worktree", "new", "two");
    const one = await services("env", "up", "--worktree", "one");
    const two = await services("env", "up", "--worktree", "two");
    expect(one.map((s) => [s.service, s.place, s.status])).toEqual([
      ["db", "shared", "started"],
      ["api", "one", "started"],
    ]);
    expect(two.map((s) => [s.service, s.status])).toEqual([
      ["db", "running"],
      ["api", "started"],
    ]);
    expect(two[0]?.pid).toBe(one[0]?.pid);
    const [a1, a2] = [one[1]?.ports.http, two[1]?.ports.http];
    expect(a1).not.toBe(a2);
    const db = one[0]?.ports.pg;
    expect(await (await fetch(`http://127.0.0.1:${a1}/`)).text()).toBe(`one postgres://127.0.0.1:${db}/shop`);
    expect(await (await fetch(`http://127.0.0.1:${a2}/`)).text()).toBe(`two postgres://127.0.0.1:${db}/shop`);
    const logs = await mt("env", "logs", "api", "--worktree", "one");
    expect((logs.json.data as { text: string }).text).toBe(`api on ${a1}`);
  }, 60_000);

  test("removing a worktree stops its services; the shared database stays for the other", async () => {
    const rm = await mt("worktree", "rm", "one", "--force");
    expect((rm.json.data as { stoppedServices: string[] }).stoppedServices).toEqual(["api"]);
    const two = await services("env", "status", "--worktree", "two");
    expect(two.filter((s) => s.status === "running").map((s) => s.service)).toEqual(["db", "api"]);
    const down = await mt("env", "down", "--worktree", "two");
    expect((down.json.data as { stopped: string[] }).stopped).toEqual(["api"]);
  }, 60_000);

  test("a service that never gets ready is an error that points to its log", async () => {
    const r = await mt("env", "up", "stuck");
    const e = r.json.error as { message: string; hint: string; details: { log: string } };
    expect([r.code === 0, e.message, e.hint]).toEqual([
      false,
      "stuck did not become ready within 800 ms",
      "See `metator env logs stuck`; it keeps running for that.",
    ]);
    expect(e.details.log).toContain("starting forever");
    await mt("env", "down", "stuck");
  }, 60_000);

  test("compose services: project per place, up, logs and stop through docker", async () => {
    const up = await services("env", "up", "cache");
    expect(up.map((s) => [s.service, s.status])).toEqual([["cache", "started"]]);
    expect(((await mt("env", "logs", "cache")).json.data as { text: string }).text).toContain(
      "Ready to accept",
    );
    await mt("env", "down", "cache");
    expect((await repo.read("docker-calls.txt")).trim().split("\n")).toEqual([
      "compose -p metator-main -f compose.yml up -d cache",
      "compose -p metator-main -f compose.yml logs --no-color --tail 50 cache",
      "compose -p metator-main -f compose.yml stop cache",
    ]);
  }, 60_000);
});
