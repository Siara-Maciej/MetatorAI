import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_KIND,
  bundleLayout,
  bundleManifest,
  glibcFloor,
  linuxArch,
  linuxLauncher,
} from "../src/linux-bundle.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("the portable Linux CLI bundle (ADR-0105)", () => {
  test("Node's, Docker's and uname's names of an architecture are the bundle's", () => {
    expect(["x64", "x86_64", "amd64", "AMD64"].map(linuxArch)).toEqual(["x64", "x64", "x64", "x64"]);
    expect(["arm64", "aarch64"].map(linuxArch)).toEqual(["arm64", "arm64"]);
    expect(["riscv64", "", "ia32"].map(linuxArch)).toEqual([undefined, undefined, undefined]);
  });

  test("one folder per architecture: the launcher in bin, the executable and its resources in libexec", () => {
    expect(bundleLayout("arm64")).toEqual({
      root: "metator-linux-arm64",
      launcher: "metator-linux-arm64/bin/metator",
      executable: "metator-linux-arm64/libexec/metator",
      resources: "metator-linux-arm64/libexec/metator-resources",
      tarball: "metator-linux-arm64.tar.gz",
      triple: "aarch64-unknown-linux-gnu",
    });
    expect(bundleLayout("x64").triple).toBe("x86_64-unknown-linux-gnu");
  });

  test("the manifest is a versioned document that names the tarball, its launcher and its digest", () => {
    const m = bundleManifest({ arch: "x64", version: "0.4.0", sha256: "ab".repeat(32), glibc: "2.28" });
    expect(Object.keys(m).slice(0, 2)).toEqual(["kind", "schemaVersion"]);
    expect(m).toEqual({
      kind: BUNDLE_KIND,
      schemaVersion: 1,
      version: "0.4.0",
      platform: "linux",
      libc: "glibc",
      glibc: "2.28",
      arch: "x64",
      tarball: "metator-linux-x64.tar.gz",
      entry: "metator-linux-x64/bin/metator",
      sha256: "ab".repeat(32),
    });
  });

  test("the glibc a bundle needs is the newest symbol version its programs and addons ask for", () => {
    const objdump = [
      "0000 DF *UND* 0000 (GLIBC_2.2.5) read\n0000 DF *UND* 0000 (GLIBC_2.17) clock_gettime",
      "0000 DF *UND* 0000 (GLIBC_2.9) pipe2\n0000 DF *UND* 0000 (GLIBC_2.28) fcntl64",
      "no versions here",
    ];
    expect(glibcFloor(objdump)).toBe("2.28");
    expect(glibcFloor(["(GLIBC_2.34) forkpty", "(GLIBC_2.4) x", "(GLIBC_PRIVATE) y"])).toBe("2.34");
    // By major, then minor, as numbers: 2.10 is newer than 2.9, and a 3.x newer than any 2.x.
    expect(glibcFloor(["(GLIBC_2.9) a", "(GLIBC_2.10) b"])).toBe("2.10");
    expect(glibcFloor(["(GLIBC_2.34) a", "(GLIBC_3.1) b"])).toBe("3.1");
    expect(glibcFloor([])).toBeUndefined();
  });

  test("the launcher names its resources, follows a link to itself and passes every argument whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-bundle-"));
    dirs.push(dir);
    const root = join(dir, "metator-linux-x64");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(root, "libexec", "metator-resources"), { recursive: true });
    // A stand-in executable that prints what it got.
    await writeFile(join(root, "libexec", "metator"), '#!/bin/sh\nprintf "%s|" "$METATOR_RESOURCES" "$@"\n');
    await chmod(join(root, "libexec", "metator"), 0o755);
    const launcher = join(root, "bin", "metator");
    // The checks of the machine are the test's: this one is an x64 with glibc.
    await writeFile(launcher, linuxLauncher("x64", { machine: "echo x86_64", loader: "/bin/sh" }));
    await chmod(launcher, 0o755);
    await mkdir(join(dir, "usr-local-bin"));
    await symlink(launcher, join(dir, "usr-local-bin", "metator"));
    for (const program of [launcher, join(dir, "usr-local-bin", "metator")]) {
      const r = Bun.spawnSync([program, "setup", "a b", ""], { env: { PATH: "/usr/bin:/bin" } });
      expect([r.exitCode, r.stdout.toString()]).toEqual([
        0,
        `${join(root, "libexec", "metator-resources")}|setup|a b||`,
      ]);
    }
  });

  test("on another architecture or without glibc the launcher says why and stops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-bundle-"));
    dirs.push(dir);
    const run = async (script: string) => {
      const file = join(dir, `launcher-${Math.random().toString(36).slice(2)}`);
      await writeFile(file, script);
      await chmod(file, 0o755);
      const r = Bun.spawnSync([file, "version"], { env: { PATH: "/usr/bin:/bin" } });
      return [r.exitCode, r.stderr.toString()] as const;
    };
    const [armCode, arm] = await run(linuxLauncher("x64", { machine: "echo aarch64", loader: "/bin/sh" }));
    expect(armCode).toBe(126);
    expect(arm).toContain("for x64");
    expect(arm).toContain("aarch64");
    const [muslCode, musl] = await run(
      linuxLauncher("arm64", { machine: "echo aarch64", loader: "/nowhere/ld-linux-aarch64.so.1" }),
    );
    expect(muslCode).toBe(126);
    expect(musl).toContain("glibc");
    // An older glibc than the bundle's programs need is named, with the one there is.
    const [oldCode, old] = await run(
      linuxLauncher("x64", {
        machine: "echo x86_64",
        loader: "/bin/sh",
        glibc: "2.28",
        libc: "echo glibc 2.24",
      }),
    );
    expect(oldCode).toBe(126);
    expect(old).toContain("glibc 2.28 or newer");
    expect(old).toContain("2.24");
    for (const there of ["glibc 2.28", "glibc 2.31", "glibc 3.0", ""]) {
      const [code] = await run(
        linuxLauncher("x64", {
          machine: "echo x86_64",
          loader: "/bin/sh",
          glibc: "2.28",
          libc: `echo ${there}`,
        }),
      );
      // Past the checks, the stand-in executable is not there: 127 from exec, not the launcher's 126.
      expect(code).not.toBe(126);
    }
    // The real checks: uname -m, the glibc loader of the architecture, getconf's glibc version.
    expect(linuxLauncher("x64", { glibc: "2.28" })).toContain("getconf GNU_LIBC_VERSION");
    expect(linuxLauncher("x64")).toContain("/lib64/ld-linux-x86-64.so.2");
    expect(linuxLauncher("arm64")).toContain("/lib/ld-linux-aarch64.so.1");
    expect(linuxLauncher("arm64")).toContain("uname -m");
  });
});
