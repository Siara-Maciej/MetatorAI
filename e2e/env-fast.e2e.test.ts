/**
 * Fast start end to end (F8.7): the real `metator` on a repository whose database takes seconds
 * to seed. `env analyze` measures that a second worktree starts at least ten times faster than a
 * cold one and records it in the profile; a warm pool worktree is taken by `run init --worktree`
 * with its services already up; `env up --affected` starts only what the branch touches; build
 * output is reused from the checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
const data = <T>(r: { json: { data?: unknown } }) => r.json.data as T;

const freePort = () => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
};

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nnode_modules/\n");
  await repo.write("bun.lock", "lock 1\n");
  await repo.write(
    ".github/metator/workflows/feature.yml",
    "kind: Workflow\nschemaVersion: 2\nid: feature\nstages:\n  - id: build\n    owner: mt-implementer\n",
  );
  await repo.write(
    "db.ts",
    'Bun.listen({ hostname: "0.0.0.0", port: Number(process.env.PORT), socket: { data() {} } });\n',
  );
  await repo.write(
    "serve.ts",
    'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(process.env.NAME ?? "") });\n',
  );
  await repo.write("apps/api/order.ts", "export const order = 1;\n");
  await repo.write("apps/web/page.ts", "export const page = 1;\n");
  await repo.write(
    "metator/environment.yml",
    `kind: Environment
schemaVersion: 2
services:
  db:
    source: { script: "bun db.ts" }
    scope: shared
    ports: { pg: ${freePort()} }
    health: { tcp: pg }
    init: [{ name: seed, run: "sleep 8" }]
  api:
    source: { script: "bun serve.ts" }
    needs: [db]
    ports: { http: ${freePort()} }
    health: { http: / }
    paths: [apps/api]
    warm: { reuse: [node_modules] }
    env: { NAME: api }
  web:
    source: { script: "bun serve.ts" }
    ports: { http: ${freePort()} }
    health: { http: / }
    paths: [apps/web]
    env: { NAME: web }
`,
  );
  await repo.commit("init");
  // Installed dependencies of the checkout, which worktrees may reuse while the lockfile matches.
  await mkdir(repo.path("node_modules/left-pad"), { recursive: true });
  await Bun.write(repo.path("node_modules/left-pad/index.js"), "module.exports = 1;\n");
}, 30_000);
afterAll(async () => {
  await mt("env", "pool", "--drain");
  await mt("env", "down", "--shared");
  await repo.dispose();
}, 60_000);

interface Profile {
  cold: { ms: number; services: Record<string, { phases: { name: string; ms: number }[] }> };
  warm: { ms: number; services: Record<string, { status: string }> };
  speedup: number;
  criticalPath: string[];
  recommendations: { id: string }[];
}

describe("fast start (real CLI, real processes)", () => {
  test("env analyze: a second worktree starts ≥10× faster than a cold one; measured and recorded", async () => {
    const r = await mt("env", "analyze");
    expect(r.code).toBe(0);
    const p = data<Profile>(r);
    const seed = p.cold.services.db?.phases.find((x) => x.name === "seed")?.ms ?? 0;
    expect(seed).toBeGreaterThanOrEqual(8000);
    expect(p.warm.services.db?.status).toBe("running");
    expect(p.speedup).toBeGreaterThanOrEqual(10);
    expect(p.criticalPath).toEqual(["db", "api"]);
    const saved = JSON.parse(await repo.read(".metator/env-profile.json"));
    expect([saved.kind, saved.schemaVersion, saved.speedup]).toEqual(["EnvProfile", 1, p.speedup]);
    // It cleaned up: no worktree left, and the shared db it started is stopped again.
    expect(data<{ worktrees: unknown[] }>(await mt("worktree", "list")).worktrees).toEqual([]);
    const status = data<{ services: { service: string; status: string }[] }>(await mt("env", "status"));
    expect(status.services.find((s) => s.service === "db")?.status).toBe("not running");
  }, 120_000);

  test("a run takes a warm pool worktree whose services already run; build output was reused", async () => {
    const fill = data<{ free: { id: string }[] }>(await mt("env", "pool", "--size", "1"));
    expect(fill.free.map((e) => e.id)).toEqual(["pool-1"]);
    expect(existsSync(repo.path(".metator/wt/pool-1/node_modules/left-pad/index.js"))).toBe(true);
    const t0 = Date.now();
    const init = await mt("run", "init", "--workflow", "feature", "--task", "Add discount", "--worktree");
    expect(init.json.error).toBeUndefined();
    const run = data<{ worktree: { id: string; branch: string } }>(init);
    expect(run.worktree.id).toBe("pool-1");
    expect(run.worktree.branch).toMatch(/^metator\/\d{8}-feature-add-discount$/);
    const up = data<{ services: { service: string; status: string }[] }>(
      await mt("env", "up", "--worktree", "pool-1"),
    );
    expect(up.services.map((s) => [s.service, s.status])).toEqual([
      ["db", "running"],
      ["web", "running"],
      ["api", "running"],
    ]);
    expect(Date.now() - t0).toBeLessThan(8000); // no seed, no start: it was all waiting
    expect((await repo.git("-C", repo.path(".metator/wt/pool-1"), "branch", "--show-current")).trim()).toBe(
      run.worktree.branch,
    );
    const pool = data<{ free: unknown[]; taken: { id: string }[] }>(await mt("env", "pool"));
    expect([pool.free, pool.taken.map((e) => e.id)]).toEqual([[], ["pool-1"]]);
    await mt("env", "down", "--worktree", "pool-1");
  }, 120_000);

  test("env up --affected starts only what the worktree's branch touches, and what that needs", async () => {
    await mt("worktree", "new", "web-fix");
    await repo.write(".metator/wt/web-fix/apps/web/page.ts", "export const page = 2;\n");
    const r = await mt("env", "up", "--worktree", "web-fix", "--affected");
    const d = data<{ services: { service: string }[]; affected: string[] }>(r);
    expect([d.affected, d.services.map((s) => s.service)]).toEqual([["apps/web/page.ts"], ["web"]]);
    const none = await mt("env", "up", "--affected");
    expect(data<{ services: unknown[] }>(none).services).toEqual([]);
    await mt("env", "down", "--worktree", "web-fix");
    const rm = await mt("worktree", "rm", "web-fix", "--force");
    expect(data<{ droppedData: string[] }>(rm).droppedData).toEqual([]);
  }, 120_000);
});
