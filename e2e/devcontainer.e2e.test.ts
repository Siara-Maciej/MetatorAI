/**
 * Dev Containers end to end with a stand-in engine (ADR-0106): the real `metator` on this computer
 * finds the dev containers a `docker` (a stand-in that runs each `exec` here, with the container's
 * environment) knows, starts one, copies a Linux CLI bundle into the container user's
 * `~/.metator/server/<version>/` once, runs `inspect`, `setup` and its commit there, starts the
 * daemon there with `serve --ensure`, and reaches it through `metator tunnel` (`exec -i … tunnel
 * --port`): HTTP and a WebSocket through a loopback forwarder like the app's. No engine is an
 * answer, not a failure; a folder no container carries is CONTAINER_MISSING.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInContainerCli } from "../packages/testing/src/stand-in-container-cli.ts";
import { CLI_ENTRY, metator, stopProcessesUnder } from "./helpers/cli.ts";

const VERSION = (
  (await Bun.file(join(import.meta.dir, "../packages/cli/package.json")).json()) as { version: string }
).version;
const arch = process.arch === "arm64" ? "arm64" : "x64";

let tmp = "";
let shop = "";
let home = "";
let engines = "";
let bundles = "";
let env: Record<string, string> = {};
let daemonPid = 0;

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) =>
  r.json.error as { code: string; message: string; details?: Data };

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.email=e2e@example.com", "-c", "user.name=E2E", ...args], {
    cwd,
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** A Linux CLI "bundle" whose launcher runs this checkout's CLI: the tarball, its manifest, its SHA-256. */
async function fakeBundle(dir: string): Promise<void> {
  const stage = join(tmp, "stage");
  const root = `metator-linux-${arch}`;
  mkdirSync(join(stage, root, "bin"), { recursive: true });
  const launcher = join(stage, root, "bin", "metator");
  writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${CLI_ENTRY} "$@"\n`);
  chmodSync(launcher, 0o755);
  mkdirSync(join(dir, arch), { recursive: true });
  const tarball = join(dir, arch, `${root}.tar.gz`);
  expect(Bun.spawnSync(["tar", "-czf", tarball, "-C", stage, root]).exitCode).toBe(0);
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(tarball).arrayBuffer());
  writeFileSync(
    join(dir, arch, "metator-bundle.json"),
    JSON.stringify({
      kind: "LinuxCliBundle",
      schemaVersion: 1,
      version: VERSION,
      platform: "linux",
      libc: "glibc",
      glibc: "2.17",
      arch,
      tarball: `${root}.tar.gz`,
      entry: `${root}/bin/metator`,
      sha256: h.digest("hex"),
    }),
  );
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "metator-e2e-devcontainer-"));
  shop = join(tmp, "shop");
  home = join(tmp, "home-vscode");
  mkdirSync(shop);
  mkdirSync(home);
  writeFileSync(join(shop, ".gitignore"), ".metator/\n");
  writeFileSync(join(shop, "README.md"), "# shop\n");
  git(shop, "init", "-q", "-b", "main");
  git(shop, "add", "-A");
  git(shop, "commit", "-qm", "init");
  bundles = join(tmp, "bundles");
  await fakeBundle(bundles);
  engines = join(tmp, "engines");
  standInContainerCli(engines, "docker", {
    serverVersion: "27.3.1",
    context: "rancher-desktop",
    containers: [
      {
        id: "0123456789abcdef",
        name: "shop_devcontainer-app-1",
        image: "mcr.microsoft.com/devcontainers/base:bookworm",
        state: "running",
        labels: {
          "devcontainer.local_folder": shop,
          "devcontainer.config_file": join(shop, ".devcontainer", "devcontainer.json"),
          "devcontainer.metadata": JSON.stringify([
            { remoteUser: "vscode", remoteEnv: { SHOP_ENV: "from-remoteEnv" } },
          ]),
        },
        // The container's own environment: its user's home, and who commits there.
        env: [
          `HOME=${home}`,
          `PATH=${process.env.PATH}`,
          "GIT_AUTHOR_NAME=Dev",
          "GIT_AUTHOR_EMAIL=dev@example.com",
          "GIT_COMMITTER_NAME=Dev",
          "GIT_COMMITTER_EMAIL=dev@example.com",
        ],
        mounts: [{ type: "bind", source: shop, destination: shop }],
      },
      {
        id: "fedcba9876543210",
        name: "api_devcontainer-app-1",
        image: "mcr.microsoft.com/devcontainers/base:bullseye",
        state: "exited",
        labels: { "devcontainer.local_folder": join(tmp, "api") },
      },
    ],
  });
  env = { PATH: `${engines}:${process.env.PATH}`, METATOR_LINUX_BUNDLES: bundles };
});

afterAll(async () => {
  if (daemonPid) {
    try {
      process.kill(daemonPid);
    } catch {}
  }
  stopProcessesUnder(tmp);
  await rm(tmp, { recursive: true, force: true });
});

describe("metator devcontainer", () => {
  test("lists the dev containers docker knows, with their folder, state, workspace, user and editor link", async () => {
    const r = await metator(["devcontainer", "list"], tmp, env);
    expect(r.code).toBe(0);
    const list = data(r) as { engine: Data; containers: Data[]; problem: null };
    expect(list.engine).toMatchObject({ program: "docker", context: "rancher-desktop", version: "27.3.1" });
    expect(list.containers.map((c) => [c.name, c.state, c.workspaceFolder, c.remoteUser])).toEqual([
      ["api_devcontainer-app-1", "stopped", null, "root"],
      ["shop_devcontainer-app-1", "running", shop, "vscode"],
    ]);
    expect(list.containers[1]?.editorUri).toBe(
      `vscode://vscode-remote/dev-container+${Buffer.from(shop).toString("hex")}`,
    );
  }, 30_000);

  test("no engine is an answer that says why; a folder no container carries is CONTAINER_MISSING", async () => {
    // A PATH with bun alone: neither docker nor nerdctl.
    const onlyBun = join(tmp, "only-bun");
    mkdirSync(onlyBun, { recursive: true });
    if (!existsSync(join(onlyBun, "bun"))) symlinkSync(process.execPath, join(onlyBun, "bun"));
    const none = await metator(["devcontainer", "list"], tmp, { PATH: onlyBun });
    expect(none.code).toBe(0);
    expect(data(none)).toMatchObject({
      engine: null,
      containers: [],
      problem: expect.stringContaining("Neither docker"),
    });
    const missing = await metator(["devcontainer", "run", join(tmp, "nowhere"), "--", "version"], tmp, env);
    expect(missing.code).toBe(1);
    expect([error(missing).code, error(missing).details?.reason]).toEqual(["NOT_FOUND", "container-missing"]);
  }, 30_000);

  test("starts a stopped container by its folder's name", async () => {
    const r = await metator(["devcontainer", "start", "api"], tmp, env);
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ name: "api_devcontainer-app-1", state: "running" });
  }, 30_000);

  test("installs the CLI into the user's ~/.metator/server/<version>/ once, with progress on stderr", async () => {
    const first = await metator(["devcontainer", "install", shop, "--bundles", bundles], tmp, env);
    expect(first.code).toBe(0);
    const launcher = join(home, ".metator", "server", VERSION, `metator-linux-${arch}`, "bin", "metator");
    expect(data(first)).toMatchObject({ version: VERSION, arch, path: launcher, copied: true });
    expect(first.stderr).toContain(
      `Copying MetatorAI ${VERSION} (Linux ${arch}) into shop_devcontainer-app-1 as vscode`,
    );
    expect(existsSync(launcher)).toBe(true);
    expect((await Bun.file(join(home, ".metator", "server", VERSION, ".installed")).text()).trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // Nothing is left beside it: no partial folder, no copied tarball.
    expect(readdirSync(join(home, ".metator", "server"))).toEqual([VERSION]);
    const again = await metator(["devcontainer", "install", "shop"], tmp, env);
    expect(data(again)).toMatchObject({ copied: false });
  }, 60_000);

  test("inspect, setup and its commit run in the container, as its user, with the container's environment", async () => {
    const inspected = await metator(
      ["devcontainer", "run", "shop", "--", "inspect", shop, "--json"],
      tmp,
      env,
    );
    expect(inspected.code).toBe(0);
    const i = data(inspected) as { kind: string; next: string; git: Data; hosts: Data[] };
    expect([i.kind, i.next]).toEqual(["repo", "setup"]);
    expect(i.git.fix).toEqual({
      feature: '"ghcr.io/devcontainers/features/git:1": {}',
      command: "sudo apt-get update && sudo apt-get install -y git",
    });
    expect(i.hosts.find((h) => h.id === "claude")?.fix).toMatchObject({
      feature: '"ghcr.io/anthropics/devcontainer-features/claude-code:1": {}',
    });

    const setup = await metator(
      ["devcontainer", "run", "shop", "--", "-C", shop, "setup", "--host", "claude", "--yes", "--json"],
      tmp,
      env,
    );
    expect(setup.code).toBe(0);
    const written = (data(setup) as { written: string[] }).written;
    expect(written).toContain("metator.config.yml");
    const committed = await metator(
      ["devcontainer", "run", "shop", "--", "-C", shop, "setup", "--commit", "--json", "--files", ...written],
      tmp,
      env,
    );
    expect(committed.code).toBe(0);
    expect(git(shop, "log", "-1", "--format=%s|%an")).toBe("Set up MetatorAI|Dev\n");

    const who = await metator(
      [
        "devcontainer",
        "exec",
        "shop",
        "--env",
        "EXTRA=1",
        "--",
        "sh",
        "-c",
        'echo "$STANDIN_USER|$SHOP_ENV|$METATOR_IN_DEVCONTAINER|$EXTRA|$(pwd)"',
      ],
      tmp,
      env,
    );
    expect(data(who)).toMatchObject({ exitCode: 0, stdout: `vscode|from-remoteEnv|1|1|${shop}\n` });
    const wrong = await metator(
      ["devcontainer", "run", "shop", "--env", "NOEQUALS", "--", "version"],
      tmp,
      env,
    );
    expect(error(wrong).code).toBe("USAGE");
  }, 120_000);

  test("serve starts the daemon in the container; the tunnel reaches it over HTTP and WebSocket", async () => {
    const served = await metator(["devcontainer", "serve", "shop", "--path", shop], tmp, env);
    expect(served.code).toBe(0);
    const s = data(served) as { url: string; port: number; pid: number; tunnel: string[]; container: Data };
    daemonPid = s.pid;
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.tunnel).toEqual([
      join(engines, "docker"),
      "exec",
      "-i",
      "-u",
      "vscode",
      "0123456789abcdef",
      join(home, ".metator", "server", VERSION, `metator-linux-${arch}`, "bin", "metator"),
      "tunnel",
      "--port",
      String(s.port),
    ]);

    // One request through the tunnel command the forwarder starts: stdin in, stdout out.
    const p = Bun.spawn(s.tunnel, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write("GET /state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    p.stdin.end();
    const [reply, said] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect([await p.exited, said]).toEqual([0, ""]);
    expect(reply.slice(0, 200)).toStartWith("HTTP/1.1 200");
    expect(reply).toContain('"ok":true');

    // A loopback forwarder like the app's: each connection one tunnel; a WebSocket through it.
    const server = Bun.listen<{ proc?: ReturnType<typeof Bun.spawn> }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          const proc = Bun.spawn(s.tunnel, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
          socket.data = { proc };
          void (async () => {
            for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) socket.write(chunk);
            socket.end();
          })();
        },
        data(socket, chunk) {
          const stdin = socket.data.proc?.stdin;
          if (stdin && typeof stdin !== "number") stdin.write(chunk);
        },
        close(socket) {
          const stdin = socket.data.proc?.stdin;
          if (stdin && typeof stdin !== "number") stdin.end();
        },
      },
    });
    try {
      const state = await fetch(`http://127.0.0.1:${server.port}/state`);
      expect(state.status).toBe(200);
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/state`);
      const first = await new Promise<string>((resolve, reject) => {
        ws.onmessage = (m) => resolve(String(m.data));
        ws.onerror = () => reject(new Error("the WebSocket through the tunnel failed"));
        setTimeout(() => reject(new Error("no message through the tunnel")), 15_000);
      });
      expect(JSON.parse(first)).toMatchObject({ ok: true });
      ws.close();
    } finally {
      server.stop(true);
    }
  }, 60_000);

  test("tunnel joins stdin and stdout to a port; nothing listening is an error on stderr", async () => {
    const echo = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.write(chunk);
        },
      },
    });
    try {
      const p = Bun.spawn(["bun", CLI_ENTRY, "tunnel", "--port", String(echo.port)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      p.stdin.write("ping\n");
      const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
      const got = await reader.read();
      expect(new TextDecoder().decode(got.value)).toBe("ping\n");
      echo.stop(true);
      expect(await p.exited).toBe(0);
    } finally {
      echo.stop(true);
    }
    const closed = await metator(["tunnel", "--port", "1"], tmp, {}, "").catch((e: Error) => e.message);
    expect(String(closed)).toContain("expected exactly one stdout line, got 0");
    const p = Bun.spawn(["bun", CLI_ENTRY, "tunnel", "--port", "1"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    p.stdin.end();
    const [out, said, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect([out, code]).toEqual(["", 1]);
    expect(said).toContain("nothing listens on 127.0.0.1:1");
  }, 30_000);
});
