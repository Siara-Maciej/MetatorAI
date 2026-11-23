/**
 * The portable Linux CLI bundle end to end (ADR-0105): `scripts/linux-cli-bundle.ts` builds the
 * compiled `metator` with its native addons and launcher as one tarball; unpacked in a fresh
 * folder, as a Dev Container would get it, it runs with a clean environment (no Bun, no
 * node_modules, no checkout): version, inspect, setup and its commit, an oxc parse, the daemon with
 * the scenario host and its sessions in real PTYs, and the sandbox runtime on the executable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopProcessesUnder } from "./helpers/cli.ts";

const ROOT = resolve(import.meta.dir, "..");
const linux = process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");
const arch = process.arch === "arm64" ? "arm64" : "x64";

let tmp = "";
let launcher = "";
let resources = "";
let home = "";
let manifest: Record<string, string | number> = {};
let out = "";
let daemonPid = 0;

/** Only the system's folders: no bun, no metator, no checkout. */
const CLEAN_PATH = "/usr/bin:/bin";

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

async function run(
  args: readonly string[],
  cwd: string,
  extra: Record<string, string> = {},
): Promise<{ code: number; json: Envelope; stderr: string }> {
  const p = Bun.spawn([launcher, ...args, "--json"], {
    cwd,
    // A clean environment: what `docker exec` gives a program, and nothing of this machine's.
    env: { PATH: CLEAN_PATH, HOME: home, METATOR_NO_REAL_HOSTS: "1", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const line = out.trim().split("\n").at(-1) ?? "";
  return { code, json: (line.startsWith("{") ? JSON.parse(line) : { ok: false }) as Envelope, stderr: err };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

async function repo(name: string): Promise<string> {
  const dir = join(tmp, name);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, ".gitignore"), ".metator/\n");
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n');
  await git(dir, "init", "-q");
  await git(dir, "config", "user.name", "E2E");
  await git(dir, "config", "user.email", "e2e@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "init");
  return dir;
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

beforeAll(async () => {
  if (!linux) return;
  tmp = await realpath(await mkdtemp(join(tmpdir(), "metator-linux-bundle-e2e-")));
  // CI proves the bundle it ships (METATOR_LINUX_BUNDLE: the folder the build wrote); else one is built here.
  const given = process.env.METATOR_LINUX_BUNDLE;
  out = given ? resolve(ROOT, given) : join(tmp, "out");
  if (!given) {
    const built = Bun.spawnSync(["bun", "scripts/linux-cli-bundle.ts", "--arch", arch, "--out", out], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (built.exitCode !== 0) throw new Error(`the bundle did not build: ${built.stderr.toString()}`);
  }
  manifest = JSON.parse(await readFile(join(out, "metator-bundle.json"), "utf8"));
  // Unpacked in a fresh folder, as copied into a container.
  const opt = join(tmp, "container", "opt");
  await mkdir(opt, { recursive: true });
  const untar = Bun.spawnSync(["tar", "-xzf", join(out, String(manifest.tarball)), "-C", opt]);
  if (untar.exitCode !== 0) throw new Error(`tar: ${untar.stderr.toString()}`);
  launcher = join(opt, String(manifest.entry));
  resources = join(opt, `metator-linux-${arch}`, "libexec", "metator-resources");
  home = join(tmp, "home");
  await mkdir(home);
}, 180_000);

afterAll(async () => {
  if (!linux) return;
  if (daemonPid) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {}
    await Bun.sleep(500);
  }
  stopProcessesUnder(tmp);
  await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!linux)("the portable Linux CLI bundle (built, unpacked, clean environment)", () => {
  test("the tarball is the one its manifest names, and holds the launcher, the executable and its resources", async () => {
    expect(Object.keys(manifest).slice(0, 2)).toEqual(["kind", "schemaVersion"]);
    expect([manifest.kind, manifest.schemaVersion, manifest.arch, manifest.libc]).toEqual([
      "LinuxCliBundle",
      1,
      arch,
      "glibc",
    ]);
    // The oldest glibc it runs on, measured from its programs; the launcher checks it.
    expect(String(manifest.glibc)).toMatch(/^2\.\d+$/);
    const h = new Bun.CryptoHasher("sha256");
    h.update(await Bun.file(join(out, String(manifest.tarball))).arrayBuffer());
    expect(h.digest("hex")).toBe(String(manifest.sha256));
    const exe = join(tmp, "container", "opt", `metator-linux-${arch}`, "libexec", "metator");
    for (const program of [launcher, exe]) expect(statSync(program).mode & 0o111).toBe(0o111);
    for (const file of [
      `native/linux-${arch}/oxc-parser.node`,
      `native/linux-${arch}/oxc-resolver.node`,
      "node-pty/package.json",
      "sandbox-runtime/dist/cli.js",
      "canon/metator",
    ])
      expect(existsSync(join(resources, file))).toBe(true);
    // Nothing of a JavaScript runtime on the clean PATH: what runs is the bundle alone.
    expect(Bun.which("bun", { PATH: CLEAN_PATH })).toBeNull();
    expect(Bun.which("metator", { PATH: CLEAN_PATH })).toBeNull();
  });

  test("version, inspect, setup and a commit of what setup wrote", async () => {
    const r = await repo("shop");
    const version = await run(["version"], r);
    expect([version.code, version.json.data]).toEqual([0, { name: "metator-ai", version: manifest.version }]);

    const inspected = await run(["inspect", r], tmp);
    expect(inspected.code).toBe(0);
    const i = inspected.json.data as { kind: string; next: string; writes: Record<string, string[]> };
    expect([i.kind, i.next]).toEqual(["repo", "setup"]);
    expect(i.writes.claude).toContain("metator.config.yml");

    // The canon setup installs comes from the bundle's resources.
    const setup = await run(["setup", "--host", "claude", "--yes"], r);
    expect([setup.code, setup.json.ok]).toEqual([0, true]);
    const written = (setup.json.data as { written: string[] }).written;
    expect(written).toEqual(i.writes.claude as string[]);

    const commit = await run(["setup", "--commit", "--files", ...written], r);
    expect(commit.code).toBe(0);
    expect((await git(r, "log", "-1", "--format=%s")).trim()).toBe("Set up MetatorAI");
    expect((await git(r, "status", "--porcelain")).trim()).toBe("");
  }, 120_000);

  test("an oxc parse and resolve: the napi-rs addons load from the resources", async () => {
    const r = await repo("parse");
    const found = await run(["symbols", "find", "a"], r);
    expect(found.json.data).toEqual({
      name: "a",
      definitions: [{ file: "src/a.ts", line: 1, typeOnly: false }],
      reexportedBy: [],
    });
    const dependents = await run(["graph", "dependents", "src/a.ts"], r);
    expect((dependents.json.data as { files: string[] }).files).toEqual(["src/b.ts"]);
    // Moved away, an addon says where it looked, and only the commands that parse fail.
    await rename(join(resources, "native"), join(resources, "native-away"));
    try {
      const without = await run(["graph", "dependents", "src/a.ts"], r);
      expect(without.json.error?.message).toContain("native addon cannot load");
      expect((await run(["version"], r)).code).toBe(0);
    } finally {
      await rename(join(resources, "native-away"), join(resources, "native"));
    }
  }, 60_000);

  test("the daemon with the scenario host: its conductor and a shell in real PTYs, and a pane's plain metator is the bundle's", async () => {
    const r = await repo("serve");
    await writeFile(
      join(r, "scenario.yml"),
      'kind: AgentScenario\nschemaVersion: 1\nagents:\n  mt-orchestrator:\n    - - say: "conductor from the bundle"\n      - ask: { question: "Go on?", options: [yes, no] }\n',
    );
    const scenario = { METATOR_HOST: "scenario", METATOR_AGENT_SCENARIO: join(r, "scenario.yml") };
    const setup = await run(["setup", "--host", "claude", "--yes"], r);
    expect(setup.code).toBe(0);
    const ensured = await run(["serve", "--ensure", "--port", "0"], r, scenario);
    expect(ensured.code).toBe(0);
    const { url, pid } = ensured.json.data as { url: string; pid: number };
    daemonPid = pid;
    const runId = (
      (await run(["run", "init", "--workflow", "mt-quick", "--task", "Say hi"], r, scenario)).json.data as {
        runId: string;
      }
    ).runId;
    const post = async (path: string, body: unknown) =>
      (await (
        await fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body) })
      ).json()) as Envelope;
    expect((await post(`/runs/${runId}/pty-open`, {})).ok).toBe(true);
    const shell = await post("/panes", {
      runId,
      role: "shell",
      label: "sh",
      argv: ["sh", "-c", "tty; command -v metator; metator version; sleep 30"],
    });
    const shellId = (shell.data as { id: string }).id;
    const text = async (pane: string) =>
      ((await run(["pane", "read", pane], r)).json.data as { text?: string } | undefined)?.text ?? "";
    const conductor = await until("the conductor's words", async () => {
      const t = await text("w1:p1");
      return t.includes("Go on?") ? t : undefined;
    });
    expect(conductor).toContain("conductor from the bundle");
    const sh = await until("the shell's lines", async () => {
      const t = (await text(shellId)).replace(/\s*\n\s*|\r/g, "");
      return t.includes(`"version":"${manifest.version}"`) ? t : undefined;
    });
    expect(sh).toMatch(/^\/dev\/pts\/\d+/);
    expect(sh).toContain(join(`metator-linux-${arch}`, "libexec", "metator"));
    process.kill(pid, "SIGTERM");
    await until("the daemon to stop", async () =>
      existsSync(join(r, ".metator", "daemon.json")) ? undefined : true,
    );
    daemonPid = 0;
  }, 120_000);

  test("the sandbox runtime runs on the executable; doctor says when the bundle lacks it", async () => {
    const r = await repo("sandbox");
    const exe = join(tmp, "container", "opt", `metator-linux-${arch}`, "libexec", "metator");
    const help = Bun.spawnSync([exe, join(resources, "sandbox-runtime", "dist", "cli.js"), "--help"], {
      env: { PATH: CLEAN_PATH, HOME: home, BUN_BE_BUN: "1" },
      stdout: "pipe",
    });
    expect([help.exitCode, help.stdout.toString().split("\n")[0]]).toEqual([
      0,
      "Usage: srt [options] [command] [command...]",
    ]);
    expect((await run(["config", "set", "sandbox.enabled", "true", "--scope", "repo"], r)).code).toBe(0);
    const isolation = async () =>
      (
        (await run(["doctor"], r)).json.data as {
          checks: { id: string; message: string }[];
        }
      ).checks.find((c) => c.id === "isolation")?.message ?? "";
    expect(await isolation()).not.toContain("sandbox runtime");
    await rename(join(resources, "sandbox-runtime"), join(resources, "sandbox-runtime-away"));
    try {
      expect(await isolation()).toContain("the sandbox runtime is not at");
    } finally {
      await rename(join(resources, "sandbox-runtime-away"), join(resources, "sandbox-runtime"));
    }
  }, 60_000);
});
