import { describe, expect, test } from "bun:test";
import {
  type ContainerCommand,
  type ContainerDetails,
  type ContainerEngine,
  DevContainers,
  type DevContainersDependencies,
  err,
  type LinuxBundle,
  MetatorError,
  ok,
  type ProcessResult,
} from "../src/index.ts";

const bundle: LinuxBundle = {
  version: "0.5.0",
  arch: "x64",
  tarball: "/app/linux-cli/x64/metator-linux-x64.tar.gz",
  entry: "metator-linux-x64/bin/metator",
  sha256: "bbb",
  glibc: "2.31",
};

const container = (over: Partial<ContainerDetails> = {}): ContainerDetails => ({
  id: "c1",
  name: "/shop-dev",
  image: "img",
  state: "running",
  user: "",
  labels: { "devcontainer.local_folder": "/home/me/shop" },
  env: ["PATH=/usr/bin"],
  mounts: [{ type: "bind", source: "/home/me/shop", destination: "/workspaces/shop" }],
  metadata: [{ remoteUser: "vscode" }],
  ...over,
});

const probe = (installed = "") =>
  `__metator_probe__\nmachine=x86_64\nuser=vscode\nhome=/home/vscode\nloginpath=/home/vscode/.local/bin:/usr/bin\npath=/usr/bin\nglibc=2.36\ntar=yes\ngzip=yes\n${installed}`;

const result = (stdout = "", exitCode = 0, stderr = ""): ProcessResult => ({
  stdout,
  stderr,
  exitCode,
  durationMs: 1,
});

/** An engine that records what it was asked and answers from a script. */
function engine(
  containers: ContainerDetails[],
  answer: (id: string, c: ContainerCommand) => ProcessResult = (_id, c) =>
    c.argv[0] === "sh" && c.argv[2]?.includes("__metator_probe__")
      ? result(probe())
      : result('{"version":"0.5.0"}'),
) {
  const calls: string[] = [];
  const e: ContainerEngine = {
    list: async (label) => {
      calls.push(`list ${label}`);
      return ok(containers.map((c) => c.id));
    },
    inspect: async (ids) => {
      calls.push(`inspect ${ids.join(",")}`);
      return ok(containers.filter((c) => ids.includes(c.id)));
    },
    start: async (id) => {
      calls.push(`start ${id}`);
      const i = containers.findIndex((c) => c.id === id);
      containers[i] = { ...(containers[i] as ContainerDetails), state: "running" };
      return ok(undefined);
    },
    exec: async (id, c) => {
      const what =
        c.argv[0] === "sh"
          ? c.argv[2]?.includes("__metator_probe__")
            ? "probe"
            : c.argv[2]?.startsWith("umask 022 && mkdir")
              ? `mkdir ${c.argv[4]}`
              : "install-script"
          : c.argv.join(" ");
      calls.push(`exec ${id} as ${c.user} in ${c.cwd ?? "-"}: ${what}`);
      return ok(answer(id, c));
    },
    copyIn: async (id, f) => {
      calls.push(`copy ${f.from} -> ${id}:${f.to} as ${f.user}`);
      return ok(undefined);
    },
  };
  return { e, calls };
}

const info = { program: "docker" as const, path: "/usr/bin/docker", context: "default", version: "27.3.1" };
const make = (e: ContainerEngine, b: DevContainersDependencies["bundle"] = () => ok(bundle)) =>
  new DevContainers({ engine: { info, cli: e }, bundle: b });

describe("DevContainers", () => {
  test("lists the labelled containers through the engine; no engine is a list with the problem", async () => {
    const { e, calls } = engine([container()]);
    const list = (await make(e).list())._unsafeUnwrap();
    expect(list.engine).toEqual(info);
    expect(list.containers.map((c) => [c.name, c.workspaceFolder, c.remoteUser])).toEqual([
      ["shop-dev", "/workspaces/shop", "vscode"],
    ]);
    expect(calls).toEqual(["list devcontainer.local_folder", "inspect c1"]);
    const none = new DevContainers({
      engine: { problem: "docker does not answer" },
      bundle: () => ok(bundle),
    });
    expect((await none.list())._unsafeUnwrap()).toEqual({
      engine: null,
      containers: [],
      problem: "docker does not answer",
    });
    const refused = (await none.start("/home/me/shop"))._unsafeUnwrapErr();
    expect([refused.details?.reason, refused.message]).toEqual(["no-engine", "docker does not answer"]);
    const empty = engine([]);
    expect((await make(empty.e).list())._unsafeUnwrap().containers).toEqual([]);
    expect(empty.calls).toEqual(["list devcontainer.local_folder"]);
  });

  test("starts a stopped container and answers it running; a running one is not started again", async () => {
    const { e, calls } = engine([container({ state: "exited" })]);
    const dc = make(e);
    expect((await dc.start("/home/me/shop"))._unsafeUnwrap().state).toBe("running");
    expect(calls.filter((c) => c.startsWith("start"))).toEqual(["start c1"]);
    await dc.start("/home/me/shop");
    expect(calls.filter((c) => c.startsWith("start"))).toEqual(["start c1"]);
  });

  test("a stopped container is not reached: container-stopped", async () => {
    const { e, calls } = engine([container({ state: "exited" })]);
    const r = (await make(e).exec("/home/me/shop", ["git", "init"]))._unsafeUnwrapErr();
    expect(r.details?.reason).toBe("container-stopped");
    expect(calls.some((c) => c.startsWith("exec"))).toBe(false);
    const missing = (await make(e).exec("/home/me/other", ["true"]))._unsafeUnwrapErr();
    expect(missing.details?.reason).toBe("container-missing");
    expect((await make(e).exec("/home/me/shop", []))._unsafeUnwrapErr().code).toBe("USAGE");
  });

  test("installs the bundle of the container's architecture as the remote user, then checks it runs", async () => {
    const { e, calls } = engine([container()]);
    const lines: string[] = [];
    const done = (await make(e).install("/home/me/shop", (l) => lines.push(l)))._unsafeUnwrap();
    expect(done.cli).toEqual({
      version: "0.5.0",
      arch: "x64",
      path: "/home/vscode/.metator/server/0.5.0/metator-linux-x64/bin/metator",
      copied: true,
    });
    expect(calls.slice(2)).toEqual([
      "exec c1 as vscode in -: probe",
      "exec c1 as vscode in -: mkdir /home/vscode/.metator/server",
      "copy /app/linux-cli/x64/metator-linux-x64.tar.gz -> c1:/home/vscode/.metator/server/0.5.0.incoming.tar.gz as vscode",
      "exec c1 as vscode in -: install-script",
      "exec c1 as vscode in -: /home/vscode/.metator/server/0.5.0/metator-linux-x64/bin/metator version --json",
    ]);
    expect(lines[0]).toBe("Copying MetatorAI 0.5.0 (Linux x64) into shop-dev as vscode…");
    expect(lines.at(-1)).toBe("MetatorAI 0.5.0 is installed in the container.");
  });

  test("the install script gets the folder, the copy and the SHA-256", async () => {
    let script: readonly string[] = [];
    const { e } = engine([container()], (_id, c) => {
      if (c.argv[2]?.includes("__metator_probe__")) return result(probe());
      if (c.argv[0] === "sh" && c.argv[2]?.includes("tar -xzf")) script = c.argv;
      return result('{"ok":true,"data":{"version":"0.5.0"}}');
    });
    await make(e).install("/home/me/shop");
    expect(script.slice(3)).toEqual([
      "sh",
      "/home/vscode/.metator/server/0.5.0",
      "/home/vscode/.metator/server/0.5.0.incoming.tar.gz",
      "bbb",
    ]);
  });

  test("the version there already is not copied again", async () => {
    const { e, calls } = engine([container()], (_id, c) =>
      c.argv[0] === "sh" ? result(probe("installed=0.5.0 bbb\n")) : result(""),
    );
    const done = (await make(e).install("/home/me/shop"))._unsafeUnwrap();
    expect(done.cli.copied).toBe(false);
    expect(calls.filter((c) => c.startsWith("copy"))).toEqual([]);
  });

  test("a failing step says which, with what it said; a CLI that does not run there is an error", async () => {
    const failing = (step: string) =>
      engine([container()], (_id, c) => {
        if (c.argv[2]?.includes("__metator_probe__")) return result(probe());
        const isStep =
          step === "install"
            ? c.argv[2]?.includes("tar -xzf")
            : step === "mkdir"
              ? c.argv[2]?.startsWith("umask 022 && mkdir")
              : false;
        if (isStep) return result("", 3, "no space left");
        return result('"0.5.0"');
      });
    const unpack = (await make(failing("install").e).install("/home/me/shop"))._unsafeUnwrapErr();
    expect(unpack.message).toBe("could not unpack the CLI in the container (exit 3): no space left");
    const mkdir = (await make(failing("mkdir").e).install("/home/me/shop"))._unsafeUnwrapErr();
    expect(mkdir.message).toContain("could not make the CLI's folder");
    const runs = engine([container()], (_id, c) =>
      c.argv[2]?.includes("__metator_probe__")
        ? result(probe())
        : c.argv[1] === "version"
          ? result("", 126, "metator: this Linux has no glibc")
          : result(),
    );
    const notRunning = (await make(runs.e).install("/home/me/shop"))._unsafeUnwrapErr();
    expect(notRunning.message).toContain("does not run in the container");
    expect(notRunning.message).toContain("no glibc");
  });

  test("no bundle in this installation, or an architecture without one, is an error before anything is copied", async () => {
    const { e, calls } = engine([container()]);
    const none = make(e, () => err(new MetatorError("NOT_FOUND", "no Linux CLI bundle")));
    expect((await none.install("/home/me/shop"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const arm = engine([container()], () => result(probe().replace("x86_64", "riscv64")));
    expect((await make(arm.e).install("/home/me/shop"))._unsafeUnwrapErr().details?.reason).toBe(
      "unsupported",
    );
    expect([...calls, ...arm.calls].some((c) => c.startsWith("copy"))).toBe(false);
  });

  test("runs metator there as the remote user, in the workspace, with the container's environment", async () => {
    const seen: ContainerCommand[] = [];
    const { e } = engine([container()], (_id, c) => {
      seen.push(c);
      return c.argv[0] === "sh" ? result(probe("installed=0.5.0 bbb\n")) : result('{"ok":true}');
    });
    const ran = (
      await make(e).run("/home/me/shop", ["inspect", ".", "--json"], {
        env: { METATOR_NO_REAL_HOSTS: "1" },
        stderr: "inherit",
      })
    )._unsafeUnwrap();
    expect(ran.result.stdout).toBe('{"ok":true}');
    const last = seen.at(-1) as ContainerCommand;
    expect(last.argv).toEqual([
      "/home/vscode/.metator/server/0.5.0/metator-linux-x64/bin/metator",
      "inspect",
      ".",
      "--json",
    ]);
    expect([last.user, last.cwd, last.stderr]).toEqual(["vscode", "/workspaces/shop", "inherit"]);
    expect(last.env).toEqual({
      HOME: "/home/vscode",
      USER: "vscode",
      LOGNAME: "vscode",
      PATH: "/home/vscode/.local/bin:/usr/bin",
      METATOR_IN_DEVCONTAINER: "1",
      METATOR_NO_REAL_HOSTS: "1",
    });
    const noWorkspace = engine([container({ mounts: [] })], (_id, c) =>
      c.argv[0] === "sh" ? result(probe()) : result(),
    );
    await make(noWorkspace.e).exec("/home/me/shop", ["git", "--version"]);
    expect(noWorkspace.calls.at(-1)).toBe("exec c1 as vscode in /home/vscode: git --version");
  });

  test("an engine that fails is an error, and a probe without a home is one too", async () => {
    const { e } = engine([container()], () => result(probe().replace("home=/home/vscode", "home=")));
    expect((await make(e).exec("/home/me/shop", ["true"]))._unsafeUnwrapErr().message).toContain(
      "no home folder",
    );
    const broken: ContainerEngine = {
      ...engine([]).e,
      list: async () => err(new MetatorError("COMMAND_FAILED", "docker ps failed")),
    };
    expect((await make(broken).list())._unsafeUnwrapErr().message).toBe("docker ps failed");
    expect(make(broken).engineInfo()._unsafeUnwrap()).toEqual(info);
  });
});
