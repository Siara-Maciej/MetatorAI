/**
 * Dev Containers against a real engine (ADR-0106), opt in: `METATOR_E2E_DOCKER_BUNDLES=<folder of
 * the Linux CLI bundles>` (`bun scripts/linux-cli-bundle.ts --out <folder>/x64`) and a docker that
 * answers. A `mcr.microsoft.com/devcontainers/base:bookworm` container labelled as the Dev
 * Containers extension labels it, with a temporary repository mounted: the real `metator` lists it,
 * installs the bundle as its `vscode` user, runs inspect, setup and its commit there, starts the
 * daemon there, and reaches `/state` and a pane's WebSocket through `docker exec -i … metator
 * tunnel`, joined to a loopback port as the app's forwarder does (`METATOR_E2E_FORWARD_BIN`: the
 * app's own, `cargo build --example forward`). The container is removed after.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";

const bundles = process.env.METATOR_E2E_DOCKER_BUNDLES ?? "";
const docker = Bun.which("docker");
const answers =
  bundles !== "" &&
  docker !== null &&
  Bun.spawnSync([docker, "info", "--format", "{{.ServerVersion}}"]).exitCode === 0;
const IMAGE = "mcr.microsoft.com/devcontainers/base:bookworm";
/** A terminal's escape sequences (colours, modes), to read a prompt as text. */
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
const NAME = `metator-e2e-dc-${process.pid}`;

let tmp = "";
let shop = "";
let env: Record<string, string> = {};
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.email=o@example.com", "-c", "user.name=Owner", ...args], {
    cwd,
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** The app's forwarder: each connection on a loopback port joined to one run of `tunnel` (the argv). */
function forwarder(tunnel: readonly string[]): { readonly port: number; stop(): void } {
  const server = Bun.listen<{ proc?: ReturnType<typeof Bun.spawn> }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const proc = Bun.spawn([...tunnel], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
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
  return { port: server.port, stop: () => server.stop(true) };
}

beforeAll(async () => {
  // Asked for (the bundles named) but no engine answers: a failure, never a silent skip.
  if (bundles !== "" && !answers)
    throw new Error("METATOR_E2E_DOCKER_BUNDLES is set, but docker does not answer");
  if (!answers) return;
  tmp = await mkdtemp(join(tmpdir(), "metator-e2e-dc-docker-"));
  shop = join(tmp, "shop");
  mkdirSync(join(shop, ".devcontainer"), { recursive: true });
  writeFileSync(join(shop, ".devcontainer", "devcontainer.json"), `{ "image": "${IMAGE}" }\n`);
  writeFileSync(join(shop, ".gitignore"), ".metator/\n");
  writeFileSync(join(shop, "README.md"), "# shop\n");
  git(shop, "init", "-q", "-b", "main");
  git(shop, "add", "-A");
  git(shop, "commit", "-qm", "init");
  // The container's vscode user (uid 1000) owns the mounted repository, as VS Code arranges it; a
  // runner that is not root opens it to everyone instead (git is told it is safe, below).
  const own = (p: string) => {
    if (process.getuid?.() === 0) chownSync(p, 1000, 1000);
    else chmodSync(p, statSync(p).isDirectory() ? 0o777 : 0o666);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) own(join(p, f));
  };
  own(tmp);
  chmodSync(tmp, process.getuid?.() === 0 ? 0o755 : 0o777);
  const run = Bun.spawnSync([
    docker as string,
    "run",
    "-d",
    "--name",
    NAME,
    "--label",
    `devcontainer.local_folder=${shop}`,
    "--label",
    `devcontainer.config_file=${join(shop, ".devcontainer", "devcontainer.json")}`,
    "--label",
    'devcontainer.metadata=[{"id":"ghcr.io/devcontainers/features/common-utils:2"},{"remoteUser":"vscode"}]',
    "-v",
    `${shop}:/workspaces/shop`,
    IMAGE,
    "sleep",
    "infinity",
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run: ${run.stderr.toString()}`);
  env = { METATOR_LINUX_BUNDLES: bundles };
}, 120_000);

afterAll(async () => {
  if (!answers) return;
  // What the container's user wrote in the mounted repository is removable by this user too.
  Bun.spawnSync([docker as string, "exec", "-u", "0", NAME, "chmod", "-R", "a+rwX", "/workspaces/shop"]);
  Bun.spawnSync([docker as string, "rm", "-f", NAME]);
  await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!answers)("metator devcontainer on a real docker", () => {
  test("lists the labelled container with its workspace and user, and installs the CLI as that user", async () => {
    const list = await metator(["devcontainer", "list"], tmp, env);
    const mine = (data(list).containers as Data[]).find((c) => c.name === NAME);
    expect(mine).toMatchObject({
      state: "running",
      workspaceFolder: "/workspaces/shop",
      remoteUser: "vscode",
    });
    const inst = await metator(["devcontainer", "install", shop], tmp, env);
    expect(inst.code).toBe(0);
    expect(data(inst)).toMatchObject({
      copied: true,
      path: expect.stringMatching(/^\/home\/vscode\/\.metator\/server\//),
    });
    const who = await metator(
      ["devcontainer", "exec", shop, "--", "sh", "-c", "id -un; stat -c %U%a ~/.metator/server"],
      tmp,
      env,
    );
    expect(data(who).stdout).toBe("vscode\nvscode755\n");
  }, 180_000);

  test("inspect, setup and its commit run in the container", async () => {
    for (const [k, v] of [
      ["user.name", "Dev Container"],
      ["user.email", "dev@example.com"],
      ["safe.directory", "/workspaces/shop"],
    ])
      await metator(
        ["devcontainer", "exec", shop, "--", "git", "config", "--global", k as string, v as string],
        tmp,
        env,
      );
    const i = data(
      await metator(["devcontainer", "run", shop, "--", "inspect", "/workspaces/shop", "--json"], tmp, env),
    );
    expect([i.kind, i.next]).toEqual(["repo", "setup"]);
    const setup = await metator(
      [
        "devcontainer",
        "run",
        shop,
        "--env",
        "METATOR_NO_REAL_HOSTS=1",
        "--",
        "-C",
        "/workspaces/shop",
        "setup",
        "--host",
        "claude",
        "--yes",
        "--json",
      ],
      tmp,
      env,
    );
    const written = data(setup).written as string[];
    const commit = await metator(
      [
        "devcontainer",
        "run",
        shop,
        "--",
        "-C",
        "/workspaces/shop",
        "setup",
        "--commit",
        "--json",
        "--files",
        ...written,
      ],
      tmp,
      env,
    );
    expect(commit.code).toBe(0);
    expect(git(shop, "-c", "safe.directory=*", "log", "-1", "--format=%an: %s")).toBe(
      "Dev Container: Set up MetatorAI\n",
    );
  }, 180_000);

  test("the daemon runs in the container; /state and a pane's WebSocket come through the tunnel", async () => {
    const served = data(
      await metator(
        ["devcontainer", "serve", shop, "--path", "/workspaces/shop", "--env", "METATOR_NO_REAL_HOSTS=1"],
        tmp,
        env,
      ),
    );
    const tunnel = served.tunnel as string[];
    expect(tunnel.slice(1, 6)).toEqual(["exec", "-i", "-u", "vscode", expect.any(String)]);
    const fwd = process.env.METATOR_E2E_FORWARD_BIN
      ? (() => {
          const p = Bun.spawn([process.env.METATOR_E2E_FORWARD_BIN as string, ...tunnel], {
            stdin: "pipe",
            stdout: "pipe",
          });
          return { p, port: 0 };
        })()
      : undefined;
    let port: number;
    let stop: () => void;
    if (fwd) {
      const first = await (fwd.p.stdout as ReadableStream<Uint8Array>).getReader().read();
      port = Number(new TextDecoder().decode(first.value).trim());
      stop = () => {
        fwd.p.stdin.end();
      };
    } else {
      const f = forwarder(tunnel);
      port = f.port;
      stop = f.stop;
    }
    try {
      const state = await fetch(`http://127.0.0.1:${port}/state`);
      expect(state.status).toBe(200);
      const runInit = data(
        await metator(
          [
            "devcontainer",
            "run",
            shop,
            "--env",
            "METATOR_NO_REAL_HOSTS=1",
            "--",
            "-C",
            "/workspaces/shop",
            "run",
            "init",
            "--workflow",
            "mt-quick",
            "--task",
            "Hi",
            "--json",
          ],
          tmp,
          env,
        ),
      );
      const pane = (await (
        await fetch(`http://127.0.0.1:${port}/panes`, {
          method: "POST",
          body: JSON.stringify({ runId: runInit.runId, role: "shell", label: "sh", argv: ["bash"] }),
        })
      ).json()) as { data: { id: string } };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${encodeURIComponent(pane.data.id)}?by=e2e`);
      let screen = "";
      let sent = false;
      const seen = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no answer in the pane: ${screen.slice(-300)}`)),
          30_000,
        );
        ws.onmessage = (m) => {
          const e = JSON.parse(String(m.data)) as { type: string; data?: string };
          if (e.type === "data") screen += e.data ?? "";
          if (!sent && /\$ $/.test(screen.replace(ESCAPES, ""))) {
            sent = true;
            ws.send(JSON.stringify({ type: "input", data: "echo in:$(whoami):$(command -v metator)\r" }));
          }
          if (/in:vscode:\/home\/vscode\/\.metator\/server\//.test(screen)) {
            clearTimeout(timer);
            resolve(screen);
          }
        };
      });
      expect(seen).toContain("in:vscode:");
      ws.close();
    } finally {
      stop();
      Bun.spawnSync([docker as string, "exec", NAME, "sh", "-c", `kill ${served.pid}`]);
    }
  }, 180_000);
});
