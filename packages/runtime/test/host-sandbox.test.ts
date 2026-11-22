/**
 * The sandbox every host session starts in (ADR-0104), through the composition root as the daemon
 * uses it: the repository's config, each host's own launch, the real sandbox runtime (`srt`) on
 * bubblewrap and a real PTY. The hosts are stand-ins (`standInHost`), never a real Claude Code or
 * Copilot CLI: told to `cat` a file under `sandbox.denyRead` and the repository's `.env`, each
 * gets the system's refusal (ENOENT for the denied directory, EACCES for the secret file); with
 * the sandbox off the same command reads both. Where the machine cannot hold a sandbox (no
 * bwrap, socat or rg), the tests that need one are reported as skipped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type HostSandbox,
  type MetatorConfig,
  ok,
  type SandboxSettings,
} from "@metator/core";
import { FakeTerminal, sandboxUnheldHere, standInHost } from "@metator/testing";
import { asValue } from "awilix";
import { bootstrap } from "../src/bootstrap.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const unheld = sandboxUnheldHere();
if (unheld) console.warn(`host-sandbox.test.ts: the sandbox tests are skipped here: ${unheld}`);

const SECRET = "KEY-0F-THE-PERSON";
const ENV = "TOKEN=ENV-0F-THE-REPO";

async function world(sandbox: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "metator-sandbox-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const denied = join(dir, "denied");
  mkdirSync(join(repo, ".metator", "runs", "r1"), { recursive: true });
  mkdirSync(denied, { recursive: true });
  writeFileSync(join(denied, "key"), `${SECRET}\n`);
  writeFileSync(join(repo, ".env"), `${ENV}\n`);
  const bins = {
    claude: standInHost(join(dir, "bin"), { host: "claude" }),
    copilot: standInHost(join(dir, "bin"), { host: "copilot" }),
  };
  const config: MetatorConfig = {
    ...DEFAULT_CONFIG,
    options: { "sandbox.enabled": sandbox, "sandbox.denyRead": [denied] },
  };
  const c = bootstrap({ root: repo, config: { config, source: undefined }, bins });
  return { repo, denied, hosts: c.resolve("interactiveHosts") };
}

/** Starts the host told to read both files, approves its one command, and returns the screen once it is done. */
async function readBoth(sandbox: boolean, host: "claude" | "copilot"): Promise<string> {
  const w = await world(sandbox);
  const started = await w.hosts.get(host)?.start(
    {
      agent: "mt-chat",
      prompt: `Run \`cat ${join(w.denied, "key")} .env\` with your shell tool.`,
      cwd: w.repo,
      projectRoot: w.repo,
      runDir: join(w.repo, ".metator", "runs", "r1"),
    },
    { cols: 160, rows: 40 },
  );
  const session = started?._unsafeUnwrap();
  if (!session) throw new Error(`no ${host} host`);
  let screen = "";
  let approved = false;
  const done = new Promise<void>((resolve) => {
    session.pty.onData((d) => {
      screen += d;
      // No hooks in this repository: the stand-in asks before it runs the command.
      if (!approved && screen.includes("Do you want to proceed?")) {
        approved = true;
        session.pty.write("1\r");
      }
      if (approved && /Done\./.test(screen)) resolve();
    });
  });
  await Promise.race([done, Bun.sleep(30_000)]);
  session.pty.kill();
  return screen;
}

describe("every host session starts in the sandbox while sandbox.enabled is on (ADR-0104)", () => {
  for (const host of ["claude", "copilot"] as const) {
    test.skipIf(unheld !== undefined)(
      `${host}: a denied path and the repository's .env are refused by the system`,
      async () => {
        const screen = await readBoth(true, host);
        expect(screen).toContain("No such file or directory");
        expect(screen).toContain("Permission denied");
        expect(screen).not.toContain(SECRET);
        expect(screen).not.toContain(ENV);
      },
      60_000,
    );
  }

  test("off: the same command reads both files, so the refusal above is the sandbox's", async () => {
    const screen = await readBoth(false, "copilot");
    expect(screen).toContain(SECRET);
    expect(screen).toContain(ENV);
  }, 60_000);
});

describe("the composition root starts every interactive session through its host's launch (ADR-0104)", () => {
  /** The interactive hosts of a repository on a recording sandbox and terminal: no bwrap, no PTY, no host program run. */
  async function recorded(sandbox: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "metator-launch-"));
    dirs.push(dir);
    const config: MetatorConfig = { ...DEFAULT_CONFIG, options: { "sandbox.enabled": sandbox } };
    const bins = { claude: join(dir, "bin", "claude"), copilot: join(dir, "bin", "copilot") };
    const c = bootstrap({ root: dir, config: { config, source: undefined }, bins });
    const wrapped: { argv: readonly string[]; settings: SandboxSettings }[] = [];
    const hostSandbox: HostSandbox = {
      command: (argv, settings) => {
        wrapped.push({ argv, settings });
        return ok(["sandbox-launcher", "--", ...argv]);
      },
    };
    const terminal = new FakeTerminal();
    c.register({ hostSandbox: asValue(hostSandbox), terminal: asValue(terminal) });
    return { dir, bins, hosts: c.resolve("interactiveHosts"), wrapped, terminal };
  }

  const task = (dir: string) => ({
    agent: "mt-chat",
    prompt: "Say hello",
    cwd: dir,
    projectRoot: dir,
    runDir: join(dir, ".metator", "runs", "r1"),
  });

  test("on: claude and copilot spawn the sandbox's argv around their own program", async () => {
    const w = await recorded(true);
    for (const host of ["claude", "copilot"] as const) {
      const started = await w.hosts.get(host)?.start(task(w.dir), { cols: 80, rows: 24 });
      expect(started?.isOk()).toBe(true);
      const spawned = w.terminal.spawned.at(-1);
      const asked = w.wrapped.at(-1);
      expect(asked?.argv[0]).toBe(w.bins[host]);
      expect(asked?.argv).toContain("Say hello");
      expect(spawned?.argv).toEqual(["sandbox-launcher", "--", ...(asked?.argv ?? [])]);
      expect(spawned?.cwd).toBe(w.dir);
    }
    expect(w.wrapped).toHaveLength(2);
  });

  test("off: the host's own argv is spawned and the sandbox is never asked", async () => {
    const w = await recorded(false);
    await w.hosts.get("copilot")?.start(task(w.dir), { cols: 80, rows: 24 });
    expect(w.wrapped).toEqual([]);
    expect(w.terminal.spawned[0]?.argv[0]).toBe(w.bins.copilot);
  });
});
