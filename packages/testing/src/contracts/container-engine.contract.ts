import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerEngine } from "@metator/core";
import type { StandInWorld } from "../stand-in-container-cli.ts";

/** The world every engine of the suite is given: two dev containers (one stopped) and another container. */
export const CONTAINER_WORLD: StandInWorld = {
  serverVersion: "27.3.1",
  context: "rancher-desktop",
  containers: [
    {
      id: "aaa111",
      name: "shop-dev",
      image: "mcr.microsoft.com/devcontainers/base:bookworm",
      state: "running",
      user: "vscode",
      labels: {
        "devcontainer.local_folder": "c:\\work\\shop",
        "devcontainer.config_file": "c:\\work\\shop\\.devcontainer\\devcontainer.json",
        "devcontainer.metadata": '[{"id":"common-utils"},{"remoteUser":"vscode","remoteEnv":{"X":"1"}}]',
      },
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"],
      mounts: [
        { type: "bind", source: "/run/desktop/mnt/host/c/work/shop", destination: "/workspaces/shop" },
      ],
    },
    {
      id: "bbb222",
      name: "api-dev",
      image: "mcr.microsoft.com/devcontainers/base:bullseye",
      state: "exited",
      labels: { "devcontainer.local_folder": "/home/me/api", "devcontainer.metadata": "not json" },
    },
    { id: "ccc333", name: "postgres", image: "postgres:16", state: "running", labels: { other: "x" } },
  ],
};

/**
 * Every ContainerEngine adapter must pass this suite (ADR-0106): on its CLI's stand-in
 * (`standInContainerCli`) with CONTAINER_WORLD, or on a real engine that holds the same world.
 * `make` gets the world and answers the engine; uses POSIX `sh` in exec.
 */
export function containerEngineContract(name: string, make: (world: StandInWorld) => ContainerEngine): void {
  describe(`ContainerEngine contract: ${name}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "metator-engine-contract-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));

    test("lists the containers carrying a label, stopped ones too, and none for an unknown label", async () => {
      const engine = make(CONTAINER_WORLD);
      expect([...(await engine.list("devcontainer.local_folder"))._unsafeUnwrap()].sort()).toEqual([
        "aaa111",
        "bbb222",
      ]);
      expect((await engine.list("nobody.uses.this"))._unsafeUnwrap()).toEqual([]);
    });

    test("inspects names, state, labels, user, env, mounts and the devcontainer metadata", async () => {
      const [shop, api] = (await make(CONTAINER_WORLD).inspect(["aaa111", "bbb222"]))._unsafeUnwrap();
      expect(shop).toEqual({
        id: "aaa111",
        name: "shop-dev",
        image: "mcr.microsoft.com/devcontainers/base:bookworm",
        state: "running",
        user: "vscode",
        labels: CONTAINER_WORLD.containers[0]?.labels as Record<string, string>,
        env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"],
        mounts: [
          { type: "bind", source: "/run/desktop/mnt/host/c/work/shop", destination: "/workspaces/shop" },
        ],
        metadata: [{ id: "common-utils" }, { remoteUser: "vscode", remoteEnv: { X: "1" } }],
      });
      expect([api?.state, api?.user, api?.env, api?.mounts, api?.metadata]).toEqual([
        "exited",
        "",
        [],
        [],
        [],
      ]);
    });

    test("an id the engine does not know is an error", async () => {
      expect((await make(CONTAINER_WORLD).inspect(["nope"])).isErr()).toBe(true);
      expect((await make(CONTAINER_WORLD).start("nope")).isErr()).toBe(true);
    });

    test("starts a stopped container", async () => {
      const engine = make(CONTAINER_WORLD);
      expect((await engine.start("bbb222")).isOk()).toBe(true);
      expect((await engine.inspect(["bbb222"]))._unsafeUnwrap()[0]?.state).toBe("running");
    });

    test("exec runs argv verbatim as the user, in the folder, with the environment, and keeps the exit code", async () => {
      const r = (
        await make(CONTAINER_WORLD).exec("aaa111", {
          user: "vscode",
          cwd: scratch,
          env: { METATOR_X: "a b", METATOR_Y: "$HOME" },
          argv: [
            "sh",
            "-c",
            'printf "%s|%s|%s|%s|%s" "$1" "$METATOR_X" "$METATOR_Y" "$STANDIN_USER" "$(pwd)"; echo oops >&2; exit 3',
            "sh",
            "`x` $y",
          ],
        })
      )._unsafeUnwrap();
      expect(r.stdout).toBe(`\`x\` $y|a b|$HOME|vscode|${scratch}`);
      expect([r.stderr, r.exitCode]).toEqual(["oops\n", 3]);
    });

    test("exec with stderr inherited still captures stdout", async () => {
      const r = (
        await make(CONTAINER_WORLD).exec("aaa111", {
          user: "vscode",
          argv: ["sh", "-c", "echo out; echo progress >&2"],
          stderr: "inherit",
        })
      )._unsafeUnwrap();
      expect([r.stdout, r.stderr, r.exitCode]).toEqual(["out\n", "", 0]);
    });

    test("exec past its time is killed: exit 124", async () => {
      const started = performance.now();
      const r = (
        await make(CONTAINER_WORLD).exec("aaa111", { user: "vscode", argv: ["sleep", "5"], timeoutMs: 300 })
      )._unsafeUnwrap();
      expect(r.exitCode).toBe(124);
      expect(performance.now() - started).toBeLessThan(4000);
    });

    test("copies a file in byte for byte, as the user", async () => {
      const from = join(scratch, "bundle.tar.gz");
      const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
      writeFileSync(from, bytes);
      const to = join(scratch, "copied.tar.gz");
      expect((await make(CONTAINER_WORLD).copyIn("aaa111", { from, to, user: "vscode" })).isOk()).toBe(true);
      expect(new Uint8Array(readFileSync(to))).toEqual(bytes);
      const missing = await make(CONTAINER_WORLD).copyIn("aaa111", {
        from: join(scratch, "none"),
        to,
        user: "vscode",
      });
      expect(missing.isErr()).toBe(true);
      const nowhere = await make(CONTAINER_WORLD).copyIn("aaa111", {
        from,
        to: join(scratch, "no", "dir", "x"),
        user: "vscode",
      });
      expect(nowhere.isErr()).toBe(true);
    });
  });
}
