import { describe, expect, test } from "bun:test";
import {
  bundleArch,
  type ContainerDetails,
  type ContainerProbe,
  chooseEngine,
  compareGlibc,
  type DevContainer,
  devContainerOf,
  devContainersOf,
  editorUri,
  execEnv,
  hostPathKey,
  INSTALL_SCRIPT,
  installNeeded,
  type LinuxBundle,
  launcherIn,
  linuxBundleOf,
  MKDIR_SCRIPT,
  PROBE_SCRIPT,
  parseProbe,
  pickContainer,
  remoteEnvOf,
  remoteUserOf,
  sameFolder,
  tunnelArgv,
  workspaceFolderOf,
} from "../src/domain/devcontainer.ts";

/** A devcontainer.json variable, `${name}` (not a JavaScript placeholder). */
const v = (name: string): string => `\${${name}}`;

const details = (over: Partial<ContainerDetails> = {}): ContainerDetails => ({
  id: "abc123",
  name: "/shop_devcontainer-app-1",
  image: "mcr.microsoft.com/devcontainers/base:bookworm",
  state: "running",
  user: "",
  labels: {
    "devcontainer.local_folder": "c:\\Users\\me\\shop",
    "devcontainer.config_file": "c:\\Users\\me\\shop\\.devcontainer\\devcontainer.json",
  },
  env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"],
  mounts: [
    { type: "bind", source: "/run/desktop/mnt/host/c/Users/me/shop", destination: "/workspaces/shop" },
  ],
  metadata: [{ id: "ghcr.io/devcontainers/features/common-utils:2" }, { remoteUser: "vscode" }],
  ...over,
});

describe("finding dev containers", () => {
  test("a container with the local folder label is a dev container, with its folder, user and editor link", () => {
    expect(devContainerOf(details())).toEqual({
      id: "abc123",
      name: "shop_devcontainer-app-1",
      localFolder: "c:\\Users\\me\\shop",
      configFile: "c:\\Users\\me\\shop\\.devcontainer\\devcontainer.json",
      state: "running",
      workspaceFolder: "/workspaces/shop",
      remoteUser: "vscode",
      image: "mcr.microsoft.com/devcontainers/base:bookworm",
      editorUri: `vscode://vscode-remote/dev-container+${Buffer.from("c:\\Users\\me\\shop").toString("hex")}`,
    });
    expect(devContainerOf(details({ labels: { "other.label": "x" } }))).toBeUndefined();
    expect(devContainerOf(details({ labels: { "devcontainer.local_folder": " " } }))).toBeUndefined();
    expect(devContainerOf(details({ state: "exited" }))?.state).toBe("stopped");
    expect(
      devContainerOf(details({ labels: { "devcontainer.local_folder": "/home/me/shop" } }))?.configFile,
    ).toBeNull();
  });

  test("the list is sorted by the folder's name and leaves other containers out", () => {
    const list = devContainersOf([
      details({ id: "2", labels: { "devcontainer.local_folder": "/w/zoo" } }),
      details({ id: "3", labels: {} }),
      details({ id: "1", labels: { "devcontainer.local_folder": "C:\\w\\api" } }),
    ]);
    expect(list.map((c) => c.id)).toEqual(["1", "2"]);
  });

  test("a running container is picked before a stopped one of the same folder; none is container-missing", () => {
    const stopped = devContainerOf(details({ id: "old", state: "exited" }));
    const running = devContainerOf(details({ id: "new" }));
    const all = [stopped, running].filter((c) => c !== undefined);
    expect(pickContainer(all, "C:/Users/me/shop/")._unsafeUnwrap().id).toBe("new");
    expect(pickContainer([all[0] as DevContainer], "c:\\Users\\me\\shop")._unsafeUnwrap().id).toBe("old");
    const none = pickContainer(all, "c:\\Users\\me\\other")._unsafeUnwrapErr();
    expect([none.code, none.details?.reason]).toEqual(["NOT_FOUND", "container-missing"]);
    expect(none.hint).toContain("devcontainer up");
  });

  test("at a terminal a container is named by its folder's name, its name or its id; two folders of one name are refused", () => {
    const shop = devContainerOf(details()) as DevContainer;
    const other = devContainerOf(
      details({ id: "zzz999888", name: "/x", labels: { "devcontainer.local_folder": "/srv/shop" } }),
    ) as DevContainer;
    const api = devContainerOf(
      details({ id: "def456789", name: "/api-dev", labels: { "devcontainer.local_folder": "/w/api" } }),
    ) as DevContainer;
    expect(pickContainer([shop, api], "shop")._unsafeUnwrap().id).toBe("abc123");
    expect(pickContainer([shop, api], "api-dev")._unsafeUnwrap().id).toBe("def456789");
    expect(pickContainer([shop, api], "def456")._unsafeUnwrap().id).toBe("def456789");
    expect(pickContainer([shop, api], "def4")._unsafeUnwrapErr().details?.reason).toBe("container-missing");
    const two = pickContainer([shop, other, api], "shop")._unsafeUnwrapErr();
    expect([two.code, two.hint]).toEqual([
      "USAGE",
      "Name one by its folder: c:\\Users\\me\\shop, /srv/shop.",
    ]);
    expect(pickContainer([shop, other], "/srv/shop")._unsafeUnwrap().id).toBe("zzz999888");
  });
});

describe("the workspace folder", () => {
  test("engines say a Windows folder in their own ways; all are the same key", () => {
    const key = "c:/users/me/shop";
    for (const p of [
      "c:\\Users\\me\\shop",
      "C:\\Users\\me\\shop\\",
      "/run/desktop/mnt/host/c/Users/me/shop",
      "/host_mnt/c/Users/me/shop",
      "/mnt/c/Users/me/shop",
      "C:/Users/me/shop",
    ])
      expect(hostPathKey(p)).toBe(key);
    expect(hostPathKey("\\\\wsl.localhost\\Ubuntu\\home\\me\\shop")).toBe("/home/me/shop");
    expect(hostPathKey("//wsl$/Ubuntu/home/me")).toBe("/home/me");
    expect(hostPathKey("/home/Me/Shop/")).toBe("/home/Me/Shop");
    expect(hostPathKey("/")).toBe("/");
    expect(sameFolder("/home/me/Shop", "/home/me/shop")).toBe(false);
    expect(sameFolder("C:\\A", "c:/a")).toBe(true);
  });

  test("the mount of the local folder, or of a folder above it, gives the folder inside", () => {
    const bind = (source: string, destination: string) => ({ type: "bind", source, destination });
    expect(workspaceFolderOf("/home/me/shop", [bind("/home/me/shop", "/workspaces/shop/")])).toBe(
      "/workspaces/shop",
    );
    expect(
      workspaceFolderOf("/home/me/repos/shop", [
        bind("/home/me", "/h"),
        bind("/home/me/repos", "/workspaces"),
      ]),
    ).toBe("/workspaces/shop");
    expect(workspaceFolderOf("C:\\code\\shop", [bind("/mnt/c/code/shop", "/src")])).toBe("/src");
  });

  test("else a mount of a folder with its name, else one under /workspaces, else none", () => {
    expect(
      workspaceFolderOf("\\\\server\\share\\shop", [
        { type: "bind", source: "/some/vm/path/Shop", destination: "/code" },
      ]),
    ).toBe("/code");
    expect(
      workspaceFolderOf("/elsewhere/shop", [
        { type: "volume", source: "/var/lib/docker/volumes/x", destination: "/workspaces/shop-vol" },
      ]),
    ).toBe("/workspaces/shop-vol");
    expect(workspaceFolderOf("/w/shop", [{ type: "volume", source: "v", destination: "/data" }])).toBeNull();
    expect(
      workspaceFolderOf("/w/shop", [{ type: "volume", source: "/w/shop", destination: "/x" }]),
    ).toBeNull();
  });
});

describe("the user and the environment", () => {
  test("remoteUser, else containerUser, else the image's user, else root; later metadata wins", () => {
    expect(remoteUserOf({ metadata: [{ remoteUser: "a" }, { remoteUser: "b" }], user: "x" })).toBe("b");
    expect(remoteUserOf({ metadata: [{ containerUser: "c" }, { remoteUser: " " }], user: "x" })).toBe("c");
    expect(remoteUserOf({ metadata: [{ remoteUser: "a" }, { containerUser: "c" }], user: "x" })).toBe("a");
    expect(remoteUserOf({ metadata: [], user: "1000:1000" })).toBe("1000:1000");
    expect(remoteUserOf({ metadata: [], user: " " })).toBe("root");
  });

  test("remoteEnv takes the container's variables and leaves out what only the host knows", () => {
    const env = remoteEnvOf({
      env: ["PATH=/usr/bin", "LANG=C"],
      metadata: [
        { remoteEnv: { PATH: `${v("containerEnv:PATH")}:/opt/x`, FROM: "first" } },
        {
          remoteEnv: {
            FROM: "second",
            ONLY_HOST: v("localEnv:HOME"),
            DEFAULTED: v("containerEnv:NOPE:fallback"),
            EMPTY: v("containerEnv:NOPE"),
            GONE: null,
          },
        },
        { remoteEnv: ["not", "an", "object"] },
      ],
    });
    expect(env).toEqual({ PATH: "/usr/bin:/opt/x", FROM: "second", DEFAULTED: "fallback", EMPTY: "" });
  });

  test("processes get the home, the login PATH, remoteEnv and the dev container sign", () => {
    const probe = parsed("loginpath=/home/vscode/.local/bin:/usr/bin");
    expect(execEnv(probe, details())).toEqual({
      HOME: "/home/vscode",
      USER: "vscode",
      LOGNAME: "vscode",
      PATH: "/home/vscode/.local/bin:/usr/bin",
      METATOR_IN_DEVCONTAINER: "1",
    });
    const noLogin = parsed("loginpath=", "user=1000");
    const env = execEnv(
      noLogin,
      details({ metadata: [{ remoteEnv: { PATH: `/x:${v("containerEnv:PATH")}` } }] }),
    );
    expect(env.PATH).toBe("/x:/usr/local/bin:/usr/bin:/bin");
    expect(env.USER).toBeUndefined();
  });
});

/** A probe's answer with some lines replaced. */
function parsed(...over: string[]): ContainerProbe {
  const lines = new Map(
    [
      "machine=x86_64",
      "user=vscode",
      "home=/home/vscode",
      "loginpath=/usr/local/bin:/usr/bin",
      "path=/usr/bin:/bin",
      "glibc=2.36",
      "loader=/lib64/ld-linux-x86-64.so.2",
      "tar=yes",
      "gzip=yes",
    ].map((l) => [l.split("=")[0] as string, l]),
  );
  for (const l of over) lines.set(l.split("=")[0] as string, l);
  return parseProbe(`profile noise\n__metator_probe__\n${[...lines.values()].join("\n")}\n`)._unsafeUnwrap();
}

describe("the probe", () => {
  test("is read after its marker; every installed version with its marker", () => {
    const p = parseProbe(
      [
        "Welcome!",
        "__metator_probe__",
        "machine=aarch64",
        "user=vscode",
        "home=/home/vscode",
        "loginpath=",
        "path=/usr/bin",
        "glibc=2.31",
        "loader=/lib/ld-linux-aarch64.so.1",
        "tar=yes",
        "installed=0.4.0 aaa",
        "installed=0.5.0 bbb",
        "installed=broken",
        "noise without equals",
      ].join("\n"),
    )._unsafeUnwrap();
    expect(p).toEqual({
      machine: "aarch64",
      user: "vscode",
      home: "/home/vscode",
      loginPath: null,
      path: "/usr/bin",
      libc: "glibc",
      glibc: "2.31",
      tar: false,
      installed: { "0.4.0": "aaa", "0.5.0": "bbb" },
    });
    expect(parseProbe("sh: 1: not found")._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
  });

  test("glibc from getconf or its loader; musl; neither", () => {
    expect(parsed("glibc=").libc).toBe("glibc");
    const musl = parseProbe(
      "__metator_probe__\nmachine=x86_64\nmusl=/lib/ld-musl-x86_64.so.1\n",
    )._unsafeUnwrap();
    expect([musl.libc, musl.glibc]).toEqual(["musl", null]);
    expect(parseProbe("__metator_probe__\nmachine=x86_64\n")._unsafeUnwrap().libc).toBe("unknown");
  });

  test("the real script runs in sh and says everything the parser reads", async () => {
    const out = Bun.spawnSync(["sh", "-c", PROBE_SCRIPT], { env: { ...process.env, HOME: "/tmp" } });
    const p = parseProbe(out.stdout.toString())._unsafeUnwrap();
    expect(p.machine).not.toBe("");
    expect(p.home).toBe("/tmp");
    expect(p.path).not.toBe("");
  });
});

const bundle: LinuxBundle = {
  version: "0.5.0",
  arch: "x64",
  tarball: "/app/linux-cli/x64/metator-linux-x64.tar.gz",
  entry: "metator-linux-x64/bin/metator",
  sha256: "bbb",
  glibc: "2.31",
};

describe("the architecture and the version check", () => {
  test("uname -m and Docker's names are the bundle's architectures", () => {
    expect([bundleArch("x86_64"), bundleArch(" AMD64"), bundleArch("x64")]).toEqual(["x64", "x64", "x64"]);
    expect([bundleArch("aarch64"), bundleArch("arm64")]).toEqual(["arm64", "arm64"]);
    expect([bundleArch("armv7l"), bundleArch("")]).toEqual([undefined, undefined]);
  });

  test("the bundle is copied in unless its version is there with the same SHA-256", () => {
    expect(installNeeded(parsed(), bundle)._unsafeUnwrap()).toBe(true);
    expect(installNeeded({ ...parsed(), installed: { "0.5.0": "bbb" } }, bundle)._unsafeUnwrap()).toBe(false);
    expect(
      installNeeded({ ...parsed(), installed: { "0.5.0": "old", "0.4.0": "bbb" } }, bundle)._unsafeUnwrap(),
    ).toBe(true);
  });

  test("a container the CLI cannot run in is refused first, by its reason", () => {
    const reason = (p: ContainerProbe) => installNeeded(p, bundle)._unsafeUnwrapErr().details?.reason;
    expect(reason(parsed("machine=aarch64"))).toBe("unsupported");
    expect(
      reason(
        parseProbe("__metator_probe__\nmachine=x86_64\nmusl=/lib/ld-musl-x86_64.so.1\n")._unsafeUnwrap(),
      ),
    ).toBe("musl");
    expect(reason(parseProbe("__metator_probe__\nmachine=x86_64\n")._unsafeUnwrap())).toBe("unsupported");
    const old = installNeeded(parsed("glibc=2.28"), bundle)._unsafeUnwrapErr();
    expect([old.details?.reason, old.message]).toEqual([
      "unsupported",
      "the container has glibc 2.28; MetatorAI's Linux CLI needs 2.31 or newer",
    ]);
    expect(installNeeded(parsed("glibc=2.31"), bundle).isOk()).toBe(true);
    expect(reason(parsed("glibc=2.30"))).toBe("unsupported");
    expect(reason(parsed("tar=no"))).toBe("unsupported");
    // Installed already: no tar is needed.
    expect(installNeeded({ ...parsed("tar=no"), installed: { "0.5.0": "bbb" } }, bundle).isOk()).toBe(true);
  });

  test("glibc versions compare by number", () => {
    expect(compareGlibc("2.31", "2.36")).toBeLessThan(0);
    expect(compareGlibc("2.4", "2.31")).toBeLessThan(0);
    expect(compareGlibc("2.31", "2.31")).toBe(0);
    expect(compareGlibc("3.0", "2.99")).toBeGreaterThan(0);
    expect(compareGlibc("2.31.1", "2.31")).toBeGreaterThan(0);
  });

  test("the launcher is in the user's folder of the version", () => {
    expect(launcherIn("/home/vscode/", bundle)).toBe(
      "/home/vscode/.metator/server/0.5.0/metator-linux-x64/bin/metator",
    );
  });

  test("a manifest is read for its architecture, its tarball beside it", () => {
    const raw = {
      kind: "LinuxCliBundle",
      schemaVersion: 1,
      version: "0.5.0",
      arch: "x64",
      tarball: "metator-linux-x64.tar.gz",
      entry: "metator-linux-x64/bin/metator",
      sha256: "bbb",
      glibc: "2.31",
    };
    expect(linuxBundleOf(raw, "x64", (n) => `/app/linux-cli/x64/${n}`)._unsafeUnwrap()).toEqual(bundle);
    const bad = (r: unknown, arch: "x64" | "arm64" = "x64") =>
      linuxBundleOf(r, arch, (n) => n)._unsafeUnwrapErr().message;
    expect(bad({ ...raw, kind: "Other" })).toContain("not a LinuxCliBundle");
    expect(bad({ ...raw, schemaVersion: 2 })).toContain("schemaVersion 2");
    expect(bad(raw, "arm64")).toContain("is for x64");
    expect(bad({ ...raw, sha256: "" })).toContain("lacks sha256");
    expect(bad(undefined)).toContain("not a LinuxCliBundle");
  });
});

describe("the engine and the links", () => {
  const facts = (program: "docker" | "nerdctl", path: string | null, version: string | null, said = "") => ({
    program,
    path,
    version,
    context: program === "docker" ? "rancher-desktop" : null,
    said,
  });

  test("docker when its engine answers, else nerdctl, else why neither", () => {
    expect(
      chooseEngine([facts("docker", "/bin/docker", "27.3.1"), facts("nerdctl", "/bin/nerdctl", "2.0")]),
    ).toEqual({
      engine: { program: "docker", path: "/bin/docker", context: "rancher-desktop", version: "27.3.1" },
    });
    expect(
      chooseEngine([
        facts("docker", "/bin/docker", null, "Cannot connect"),
        facts("nerdctl", "/bin/nerdctl", "2.0"),
      ]),
    ).toEqual({ engine: { program: "nerdctl", path: "/bin/nerdctl", context: null, version: "2.0" } });
    const none = chooseEngine([facts("docker", null, null), facts("nerdctl", null, null)]);
    expect(none).toEqual({ problem: expect.stringContaining("Neither docker nor nerdctl is installed") });
    const down = chooseEngine([
      facts("docker", "/bin/docker", null, "Cannot connect to the Docker daemon"),
      facts("nerdctl", null, null),
    ]);
    expect(down).toEqual({
      problem:
        "docker is installed, but its engine does not answer: Cannot connect to the Docker daemon. Start Docker Desktop or Rancher Desktop.",
    });
  });

  test("the editor link is the dev container's: the folder in hex, or the folder and another config as JSON", () => {
    const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
    expect(editorUri("/home/me/shop", null)).toBe(
      `vscode://vscode-remote/dev-container+${hex("/home/me/shop")}`,
    );
    expect(editorUri("/home/me/shop", "/home/me/shop/.devcontainer.json")).toBe(
      editorUri("/home/me/shop", null),
    );
    expect(editorUri("C:\\w\\sklep", "c:\\w\\sklep\\.devcontainer\\devcontainer.json")).toBe(
      `vscode://vscode-remote/dev-container+${hex("C:\\w\\sklep")}`,
    );
    const other = editorUri("C:\\w\\shop", "C:\\w\\shop\\.devcontainer\\api\\devcontainer.json");
    const json = Buffer.from(other.split("+")[1] as string, "hex").toString("utf8");
    expect(JSON.parse(json)).toEqual({
      hostPath: "C:\\w\\shop",
      configFile: {
        $mid: 1,
        path: "/C:/w/shop/.devcontainer/api/devcontainer.json",
        scheme: "vscode-fileHost",
      },
    });
    const quoted = editorUri('/w/"odd"\n', '/w/"odd"\n/x/devcontainer.json');
    expect(JSON.parse(Buffer.from(quoted.split("+")[1] as string, "hex").toString()).hostPath).toBe(
      '/w/"odd"\n',
    );
  });

  test("the tunnel runs metator tunnel in the container as its user", () => {
    expect(
      tunnelArgv(
        { path: "C:\\Program Files\\Docker\\docker.exe" },
        { id: "abc", remoteUser: "vscode" },
        "/l/metator",
        4711,
      ),
    ).toEqual([
      "C:\\Program Files\\Docker\\docker.exe",
      "exec",
      "-i",
      "-u",
      "vscode",
      "abc",
      "/l/metator",
      "tunnel",
      "--port",
      "4711",
    ]);
  });
});

describe("the install script, run by sh", () => {
  test("checks the copy, unpacks it in place for its user only, writes the marker last and removes the copy", () => {
    const dir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
    try {
      const stage = `${dir}/stage/metator-linux-x64/bin`;
      Bun.spawnSync(["mkdir", "-p", stage]);
      Bun.spawnSync(["sh", "-c", `echo '#!/bin/sh' > ${stage}/metator && chmod 755 ${stage}/metator`]);
      const server = `${dir}/.metator/server`;
      const tarball = `${server}/0.5.0.incoming.tar.gz`;
      // The engine's exec may come with any umask: the folders are still the user's only.
      const mk = Bun.spawnSync(["sh", "-c", `umask 000; ${MKDIR_SCRIPT}`, "sh", server]);
      expect(mk.exitCode).toBe(0);
      Bun.spawnSync(["tar", "-czf", tarball, "-C", `${dir}/stage`, "metator-linux-x64"]);
      const sum = Bun.spawnSync(["sha256sum", tarball]).stdout.toString().split(" ")[0] as string;
      const wrong = Bun.spawnSync([
        "sh",
        "-c",
        `umask 000; ${INSTALL_SCRIPT}`,
        "sh",
        `${server}/0.5.0`,
        tarball,
        "0000",
      ]);
      expect(wrong.exitCode).toBe(3);
      expect(wrong.stderr.toString()).toContain("the copy of the CLI is damaged");
      expect(Bun.spawnSync(["test", "-e", `${server}/0.5.0`]).exitCode).not.toBe(0);
      Bun.spawnSync(["tar", "-czf", tarball, "-C", `${dir}/stage`, "metator-linux-x64"]);
      const ok = Bun.spawnSync([
        "sh",
        "-c",
        `umask 000; ${INSTALL_SCRIPT}`,
        "sh",
        `${server}/0.5.0`,
        tarball,
        sum,
      ]);
      expect([ok.exitCode, ok.stderr.toString()]).toEqual([0, ""]);
      const ls = Bun.spawnSync([
        "sh",
        "-c",
        `stat -c '%A %n' ${server} ${server}/0.5.0 ${server}/0.5.0/.installed; ls -A ${server}`,
      ]);
      expect(ls.stdout.toString()).toBe(
        `drwxr-xr-x ${server}\ndrwxr-xr-x ${server}/0.5.0\n-rw-r--r-- ${server}/0.5.0/.installed\n0.5.0\n`,
      );
      expect(Bun.spawnSync(["cat", `${server}/0.5.0/.installed`]).stdout.toString()).toBe(`${sum}\n`);
      // The probe of that home finds the version with its marker.
      const probe = Bun.spawnSync(["sh", "-c", PROBE_SCRIPT], { env: { ...process.env, HOME: dir } });
      expect(parseProbe(probe.stdout.toString())._unsafeUnwrap().installed).toEqual({ "0.5.0": sum });
    } finally {
      Bun.spawnSync(["rm", "-rf", dir]);
    }
  });
});
