/**
 * The npm package (`bun run pack`, F8.8) end to end: the bundle runs on its own outside the
 * checkout, finds the canon it ships (setup installs it into a fresh repository), and the manifest
 * names what npm needs. Publishing stays the owner's step.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_STATE_DIR } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
let out: string;
let repo: ScratchRepo;
type Data = Record<string, unknown>;

/** The packed CLI as a user would run it: from the package directory, not from the checkout. */
async function packed(args: string[], cwd: string) {
  const proc = Bun.spawn(["bun", join(out, "bin/metator.js"), ...args], {
    cwd,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.split("\n").find((l) => l.startsWith("{")) ?? "{}";
  return { code, stderr, json: JSON.parse(line) as { ok: boolean; data?: Data; error?: Data } };
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "metator-pack-"));
  const build = Bun.spawn(["bun", "scripts/pack.ts", "--out", out], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) throw new Error(`pack failed:\n${stdout}\n${stderr}`);
  repo = await ScratchRepo.create();
  await repo.write("package.json", '{"name":"consumer","scripts":{"lint":"true","test":"true"}}\n');
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
}, 180_000);
afterAll(async () => {
  await repo.dispose();
  await rm(out, { recursive: true, force: true });
});

describe("the npm package metator-ai (bun run pack)", () => {
  test("the manifest: name, bin, files, engines, the native and optional dependencies; the canon is in the package", async () => {
    const manifest = JSON.parse(await Bun.file(join(out, "package.json")).text()) as Data;
    expect(manifest).toMatchObject({
      name: "metator-ai",
      bin: { metator: "bin/metator.js" },
      engines: { bun: ">=1.4.0" },
      dependencies: { "node-pty": "1.1.0" },
      optionalDependencies: { "@anthropic-ai/claude-agent-sdk": expect.any(String) },
    });
    for (const dir of manifest.files as string[])
      expect([dir, existsSync(join(out, dir))]).toEqual([dir, true]);
    expect(existsSync(join(out, "metator/agents/mt-orchestrator.md"))).toBe(true);
    expect(existsSync(join(out, ".github/metator/workflows/mt-feature.yml"))).toBe(true);
    expect(existsSync(join(out, "docs/metator/rules/code.yml"))).toBe(true);
    const bundle = await Bun.file(join(out, "bin/metator.js")).text();
    expect(bundle.startsWith("#!/usr/bin/env bun")).toBe(true);
    // Native and optional code stays a dependency, never inlined.
    expect(bundle).toContain('"node-pty"');
    expect(bundle).not.toContain("class UnixTerminal");
  });

  test("the bundle runs outside the checkout: version, the verbs, and setup installs the canon it ships", async () => {
    const version = await packed(["version"], repo.root);
    expect([version.code, version.json.data]).toEqual([0, { name: "metator-ai", version: "0.0.0" }]);
    const verbs = await packed(["help", "--verbs"], repo.root);
    expect((verbs.json.data as { verbs: unknown[] }).verbs.length).toBe(6);
    const setup = await packed(["setup", "--host", "copilot", "--yes"], repo.root);
    expect(setup.json.ok).toBe(true);
    const data = setup.json.data as { canon: { mode: string; steps: { create: number } }; hosts: string[] };
    expect([data.hosts, data.canon.mode, data.canon.steps.create > 20]).toEqual([
      ["copilot"],
      "install",
      true,
    ]);
    expect(existsSync(repo.path("metator/agents/mt-orchestrator.md"))).toBe(true);
    expect(existsSync(repo.path(".github/agents/mt-orchestrator.agent.md"))).toBe(true);
    const check = await packed(["generate", "--check"], repo.root);
    expect((check.json.data as { stale: unknown[] }).stale).toEqual([]);
  }, 120_000);
});
