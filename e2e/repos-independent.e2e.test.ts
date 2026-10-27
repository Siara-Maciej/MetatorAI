/**
 * Independent repositories on one machine (G1): each has its own MetatorAI, and still they never
 * collide. Two real repositories lease port blocks from one machine-wide registry, and run their
 * Compose services in projects of their own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let shop: ScratchRepo;
let billing: ScratchRepo;
let state: string;
const env = () => ({ METATOR_STATE_DIR: state, METATOR_DOCKER_BIN: join(state, "docker") });

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "metator-machine-"));
  await Bun.write(join(state, "docker"), `#!/bin/sh\necho "$*" >> "${join(state, "docker-calls.txt")}"\n`);
  await chmod(join(state, "docker"), 0o755);
  shop = await ScratchRepo.create();
  billing = await ScratchRepo.create();
  for (const repo of [shop, billing]) {
    await repo.write(".gitignore", ".metator/\n");
    await repo.write(
      "metator/environment.yml",
      "kind: Environment\nschemaVersion: 2\nservices:\n  cache:\n    source: { compose: { file: compose.yml, service: cache } }\n    scope: shared\n",
    );
    await repo.commit("init");
  }
});
afterAll(async () => {
  for (const repo of [shop, billing]) await repo.dispose();
  await rm(state, { recursive: true, force: true });
});

describe("independent repositories on one machine (real CLI)", () => {
  test("worktrees of two repositories lease different port blocks; removing one frees its block", async () => {
    const a = await metator(["worktree", "new", "feat"], shop.root, env());
    const b = await metator(["worktree", "new", "feat"], billing.root, env());
    const ports = (r: typeof a) => (r.json.data as { ports: { from: number } }).ports.from;
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(ports(a)).not.toBe(ports(b));
    const leases = JSON.parse(await Bun.file(join(state, "port-leases.json")).text());
    expect([leases.kind, leases.leases.map((l: { repo: string }) => l.repo)]).toEqual([
      "PortLeases",
      [shop.root, billing.root],
    ]);
    await metator(["worktree", "rm", "feat"], shop.root, env());
    const c = await metator(["worktree", "new", "other"], billing.root, env());
    expect(ports(c)).toBe(ports(a));
  }, 60_000);

  test("their shared Compose services run in projects of their own", async () => {
    await metator(["env", "up"], shop.root, env());
    await metator(["env", "up"], billing.root, env());
    const projects = (await Bun.file(join(state, "docker-calls.txt")).text())
      .trim()
      .split("\n")
      .map((l) => l.split(" ")[2]);
    expect(projects).toHaveLength(2);
    expect(projects[0]).not.toBe(projects[1]);
    for (const p of projects) expect(p).toMatch(/-shared$/);
    for (const repo of [shop, billing]) await metator(["env", "down", "--shared"], repo.root, env());
  }, 60_000);
});
