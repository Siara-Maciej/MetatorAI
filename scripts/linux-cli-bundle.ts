/**
 * Builds the portable Linux CLI bundle (ADR-0105, packages/cli/src/linux-bundle.ts): the compiled
 * `metator` for linux-<arch> (glibc) with its resources and a launcher, as one tarball, and its
 * manifest beside it:
 *
 *   <out>/metator-linux-<arch>.tar.gz   metator-linux-<arch>/{bin/metator, libexec/metator, libexec/metator-resources/}
 *   <out>/metator-bundle.json           kind LinuxCliBundle: version, arch, entry, sha256
 *
 * The addons are this machine's (`bun install` built node-pty here): build each architecture on a
 * machine of that architecture. Anything missing stops the build with what it looked for.
 *
 * Usage: bun scripts/linux-cli-bundle.ts [--arch x64|arm64] [--out packages/desktop/src-tauri/linux-cli/<arch>]
 */
import { chmod, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BUNDLE_MANIFEST,
  type BundleManifest,
  bundleLayout,
  bundleManifest,
  glibcFloor,
  type LinuxArch,
  linuxArch,
  linuxLauncher,
} from "../packages/cli/src/linux-bundle.ts";
import { compileCli, filesBelow } from "./compile-cli.ts";

const ROOT = resolve(import.meta.dir, "..");

export async function sha256(file: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(file).arrayBuffer());
  return h.digest("hex");
}

/**
 * The oldest glibc the bundle runs on: the newest symbol version any of its ELF files (the
 * executable, the addons, srt's seccomp helper) asks for, read with `objdump -T` (binutils).
 */
async function neededGlibc(dir: string): Promise<string> {
  const dumps: string[] = [];
  for (const file of await filesBelow(dir)) {
    const path = join(dir, file);
    const head = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) continue;
    const dump = Bun.spawnSync(["objdump", "-T", path], { stdout: "pipe", stderr: "pipe" });
    // A static program (srt's apply-seccomp) needs no glibc.
    if (dump.stderr.toString().includes("not a dynamic object")) continue;
    if (dump.exitCode !== 0)
      throw new Error(`objdump -T ${file} failed (install binutils): ${dump.stderr.toString()}`);
    dumps.push(dump.stdout.toString());
  }
  const floor = glibcFloor(dumps);
  if (!floor) throw new Error(`no glibc symbol versions in ${dir}: is objdump reading the programs?`);
  return floor;
}

export async function linuxCliBundle(o: { readonly arch: LinuxArch; readonly out: string }): Promise<{
  readonly tarball: string;
  readonly manifest: BundleManifest;
}> {
  const l = bundleLayout(o.arch);
  const stage = await mkdtemp(join(tmpdir(), "metator-linux-bundle-"));
  try {
    const built = await compileCli({ triple: l.triple, out: join(stage, "compiled") });
    const root = join(stage, "tree");
    await mkdir(join(root, dirname(l.executable)), { recursive: true });
    await rename(built.binary, join(root, l.executable));
    await chmod(join(root, l.executable), 0o755);
    await cp(built.resources, join(root, l.resources), { recursive: true });
    const glibc = await neededGlibc(join(root, l.root));
    await mkdir(join(root, dirname(l.launcher)), { recursive: true });
    await writeFile(join(root, l.launcher), linuxLauncher(o.arch, { glibc }));
    await chmod(join(root, l.launcher), 0o755);

    await mkdir(o.out, { recursive: true });
    const tarball = join(o.out, l.tarball);
    const tar = Bun.spawnSync(
      ["tar", "--owner=0", "--group=0", "--numeric-owner", "-czf", tarball, "-C", root, l.root],
      { stderr: "pipe" },
    );
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
    const pkg = (await Bun.file(join(ROOT, "packages/cli/package.json")).json()) as { version: string };
    const manifest = bundleManifest({
      arch: o.arch,
      version: pkg.version,
      sha256: await sha256(tarball),
      glibc,
    });
    await writeFile(join(o.out, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    return { tarball, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const given = opt("--arch") ?? process.arch;
  const arch = linuxArch(given);
  if (!arch) throw new Error(`no Linux CLI bundle for the architecture ${given}: x64 or arm64`);
  if (process.platform !== "linux")
    throw new Error("the Linux CLI bundle is built on Linux (its addons are this machine's)");
  if (linuxArch(process.arch) !== arch)
    throw new Error(
      `build the ${arch} bundle on a ${arch} machine: node-pty is built by bun install for this one (${process.arch})`,
    );
  const out = resolve(ROOT, opt("--out") ?? join("packages/desktop/src-tauri/linux-cli", arch));
  const r = await linuxCliBundle({ arch, out });
  console.log(
    `bundled ${r.tarball} (${(Bun.file(r.tarball).size / 1_000_000).toFixed(0)} MB), metator ${r.manifest.version}, sha256 ${r.manifest.sha256}`,
  );
}
