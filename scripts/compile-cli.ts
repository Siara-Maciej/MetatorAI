/**
 * Compiles the CLI into one executable per platform for the desktop app (ADR-0105): the Tauri
 * sidecar `binaries/metator-<target triple>` and, beside it, the resources folder
 * `metator-resources` with what an executable cannot hold:
 * - `native/<platform>-<arch>/oxc-parser.node`, `oxc-resolver.node`: the napi-rs addons, which the
 *   compiled loaders take from here (`nativeAddon` in packages/cli/src/installation.ts);
 * - `node-pty/`: its package (JavaScript, the native build; on Windows ConPTY's programs);
 * - `sandbox-runtime/`: `srt` bundled into one file with its vendored programs (Linux, macOS);
 * - `canon/`: the agents, skills, workflows and rules `setup` installs.
 * Anything missing stops the script with the file it looked for: a build never ships without it.
 *
 * Usage: bun scripts/compile-cli.ts [--triple <rust target triple>] [--out packages/desktop/src-tauri]
 */

import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { SHIPPED_DIRS } from "./pack.ts";

const ROOT = resolve(import.meta.dir, "..");
const INSTALLATION = join(ROOT, "packages/cli/src/installation.ts");

/** One platform the executable is built for: Node's names, and Bun's compile target. */
export interface Platform {
  readonly platform: "linux" | "darwin" | "win32";
  readonly arch: "x64" | "arm64";
  readonly bun: string;
}

const P = (platform: Platform["platform"], arch: Platform["arch"]): Platform => ({
  platform,
  arch,
  bun: `bun-${platform === "win32" ? "windows" : platform}-${arch}`,
});

/** What each Rust target triple Tauri builds for needs: a universal macOS app runs both architectures. */
export const TRIPLES: Readonly<Record<string, readonly Platform[]>> = {
  "x86_64-unknown-linux-gnu": [P("linux", "x64")],
  "aarch64-unknown-linux-gnu": [P("linux", "arm64")],
  "x86_64-pc-windows-msvc": [P("win32", "x64")],
  "aarch64-pc-windows-msvc": [P("win32", "arm64")],
  "x86_64-apple-darwin": [P("darwin", "x64")],
  "aarch64-apple-darwin": [P("darwin", "arm64")],
  "universal-apple-darwin": [P("darwin", "arm64"), P("darwin", "x64")],
};

/** The triple of the machine this runs on. */
export function hostTriple(platform = process.platform, arch = process.arch): string {
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  return `${cpu}-unknown-linux-gnu`;
}

/** The napi-rs binding package and file of an oxc addon for a platform (`@oxc-parser/binding-linux-x64-gnu`). */
export function napiBinding(
  addon: "oxc-parser" | "oxc-resolver",
  p: Platform,
): { pkg: string; file: string } {
  const suffix =
    p.platform === "linux"
      ? `linux-${p.arch}-gnu`
      : p.platform === "win32"
        ? `win32-${p.arch}-msvc`
        : `darwin-${p.arch}`;
  const stem = addon === "oxc-parser" ? "parser" : "resolver";
  return { pkg: `@${addon}/binding-${suffix}`, file: `${stem}.${suffix}.node` };
}

/**
 * The napi-rs loaders of oxc-parser and oxc-resolver, made to take their addon from the
 * installation: `requireNative()` returns `nativeAddon(<package>)` before trying node_modules,
 * which a compiled executable does not have. A loader that no longer has `requireNative` stops the
 * build (a new version changed it), rather than ship a CLI that cannot parse.
 */
export function rewriteNapiLoader(
  source: string,
  addon: "oxc-parser" | "oxc-resolver",
  esm: boolean,
): string {
  const marker = "function requireNative() {";
  if (!source.includes(marker))
    throw new Error(`${addon}: its loader has no \`${marker}\`; update scripts/compile-cli.ts`);
  const load = esm
    ? `import { nativeAddon as __metatorNativeAddon } from ${JSON.stringify(INSTALLATION)};\n`
    : `const { nativeAddon: __metatorNativeAddon } = require(${JSON.stringify(INSTALLATION)});\n`;
  return (
    load + source.replace(marker, `${marker}\n  return __metatorNativeAddon(${JSON.stringify(addon)});\n`)
  );
}

const napiPlugin: BunPlugin = {
  name: "metator-native-addons",
  setup(build) {
    build.onLoad({ filter: /[\\/]oxc-parser[\\/]src-js[\\/]bindings\.js$/ }, async (args) => ({
      contents: rewriteNapiLoader(await Bun.file(args.path).text(), "oxc-parser", true),
      loader: "js",
    }));
    build.onLoad({ filter: /[\\/]oxc-resolver[\\/]index\.js$/ }, async (args) => ({
      contents: rewriteNapiLoader(await Bun.file(args.path).text(), "oxc-resolver", false),
      loader: "js",
    }));
  },
};

/** A package's folder, resolved from the package that depends on it. */
function packageDir(name: string, from: string): string {
  const manifest = createRequire(join(from, "package.json")).resolve(`${name}/package.json`);
  return dirname(manifest);
}

function must(path: string, what: string): string {
  if (!existsSync(path))
    throw new Error(
      `${what} is missing: ${path}. Install the dependencies for this platform (on macOS for a universal app: bun install --cpu='*').`,
    );
  return path;
}

async function nativeAddons(out: string, platforms: readonly Platform[]): Promise<void> {
  const typescript = join(ROOT, "packages/plugin-typescript");
  for (const p of platforms) {
    const dir = join(out, "native", `${p.platform}-${p.arch}`);
    await mkdir(dir, { recursive: true });
    for (const addon of ["oxc-parser", "oxc-resolver"] as const) {
      const { pkg, file } = napiBinding(addon, p);
      let from: string;
      try {
        from = packageDir(pkg, packageDir(addon, typescript));
      } catch {
        throw new Error(
          `${pkg} is not installed (${addon}'s addon for ${p.platform}-${p.arch}); on macOS run bun install --cpu='*'`,
        );
      }
      await cp(must(join(from, file), `${addon}'s addon`), join(dir, `${addon}.node`));
    }
  }
}

/** node-pty: its JavaScript (Windows runs node-pty's own ConPTY path) and the native build of each platform. */
async function nodePty(out: string, platforms: readonly Platform[]): Promise<void> {
  const from = packageDir("node-pty", join(ROOT, "packages/plugin-node"));
  const to = join(out, "node-pty");
  await mkdir(to, { recursive: true });
  await cp(join(from, "package.json"), join(to, "package.json"));
  for (const p of platforms) {
    if (p.platform === "win32") {
      await cp(join(from, "lib"), join(to, "lib"), {
        recursive: true,
        filter: (src) => !/\.(test\.js|map)$/.test(src),
      });
      const prebuild = must(join(from, "prebuilds", `win32-${p.arch}`), "node-pty's Windows prebuild");
      await cp(prebuild, join(to, "prebuilds", `win32-${p.arch}`), {
        recursive: true,
        filter: (src) => !src.endsWith(".pdb"),
      });
      must(join(to, "prebuilds", `win32-${p.arch}`, "conpty.node"), "node-pty's conpty.node");
      continue;
    }
    // The build made on this machine at install, else node-pty's prebuild (macOS has both architectures).
    const built = join(from, "build", "Release", "pty.node");
    const prebuild = join(from, "prebuilds", `${p.platform}-${p.arch}`);
    if (existsSync(join(prebuild, "pty.node"))) {
      await cp(prebuild, join(to, "prebuilds", `${p.platform}-${p.arch}`), { recursive: true });
      if (p.platform === "darwin")
        await chmod(
          must(join(to, "prebuilds", `${p.platform}-${p.arch}`, "spawn-helper"), "node-pty's spawn-helper"),
          0o755,
        );
    } else {
      await mkdir(join(to, "build", "Release"), { recursive: true });
      await cp(
        must(built, `node-pty's native build for ${p.platform}-${p.arch}`),
        join(to, "build", "Release", "pty.node"),
      );
    }
  }
}

/** The sandbox runtime (ADR-0104): `srt` and its dependencies in one file, with the programs it vendors. Not on Windows, which has no sandbox. */
async function sandboxRuntime(out: string, platforms: readonly Platform[]): Promise<void> {
  if (platforms.every((p) => p.platform === "win32")) return;
  const from = packageDir("@anthropic-ai/sandbox-runtime", join(ROOT, "packages/plugin-node"));
  const to = join(out, "sandbox-runtime");
  const built = await Bun.build({
    entrypoints: [must(join(from, "dist", "cli.js"), "the sandbox runtime's command line")],
    outdir: join(to, "dist"),
    target: "bun",
    naming: { entry: "cli.js" },
  });
  if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
  await cp(join(from, "package.json"), join(to, "package.json"));
  for (const p of platforms)
    if (p.platform === "linux")
      await cp(
        must(join(from, "vendor", "seccomp", p.arch), "srt's seccomp programs"),
        join(to, "vendor", "seccomp", p.arch),
        {
          recursive: true,
        },
      );
  const agent = join(from, "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
  if (existsSync(agent)) await cp(agent, join(to, "vendor", "java-proxy-agent", "srt-proxy-agent.jar"));
}

async function canon(out: string): Promise<void> {
  for (const dir of SHIPPED_DIRS) await cp(join(ROOT, dir), join(out, "canon", dir), { recursive: true });
}

async function compile(p: Platform, outfile: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, "packages/cli/src/main.ts")],
    plugins: [napiPlugin],
    // A repository's .env and bunfig.toml are never read into the program (they would reach every session).
    compile: {
      target: p.bun as Bun.Build.CompileTarget,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
}

export async function compileCli(o: { readonly triple: string; readonly out: string }): Promise<{
  readonly binary: string;
  readonly resources: string;
}> {
  const platforms = TRIPLES[o.triple];
  if (!platforms)
    throw new Error(`unknown target triple ${o.triple}: one of ${Object.keys(TRIPLES).join(", ")}`);
  const windows = platforms.some((p) => p.platform === "win32");
  const binary = join(o.out, "binaries", `metator-${o.triple}${windows ? ".exe" : ""}`);
  const resources = join(o.out, "metator-resources");
  await rm(resources, { recursive: true, force: true });
  await mkdir(dirname(binary), { recursive: true });
  if (platforms.length === 1) await compile(platforms[0] as Platform, binary);
  else {
    // A universal macOS executable: one per architecture, joined by lipo.
    const parts: string[] = [];
    for (const p of platforms) {
      const part = `${binary}.${p.arch}`;
      await compile(p, part);
      parts.push(part);
    }
    const lipo = Bun.spawnSync(["lipo", "-create", "-output", binary, ...parts]);
    if (lipo.exitCode !== 0) throw new Error(`lipo failed: ${lipo.stderr.toString()}`);
    for (const part of parts) await rm(part);
  }
  await nativeAddons(resources, platforms);
  await nodePty(resources, platforms);
  await sandboxRuntime(resources, platforms);
  await canon(resources);
  return { binary, resources };
}

/** Every file below `dir`, relative to it, sorted: what the build printed it made. */
export async function filesBelow(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)));
  return out.sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const triple = opt("--triple") ?? hostTriple();
  const out = resolve(ROOT, opt("--out") ?? "packages/desktop/src-tauri");
  const r = await compileCli({ triple, out });
  const native = (await filesBelow(r.resources)).filter((f) => !f.startsWith("canon"));
  console.log(`compiled ${r.binary} (${(Bun.file(r.binary).size / 1_000_000).toFixed(0)} MB)`);
  console.log(`resources ${r.resources}:\n  ${native.join("\n  ")}\n  canon/ (${SHIPPED_DIRS.join(", ")})`);
}
