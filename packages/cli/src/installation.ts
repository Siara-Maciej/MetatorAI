import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

/**
 * Where a compiled `metator` (one executable from `bun build --compile`, shipped inside the desktop
 * app, ADR-0105) finds what the executable cannot hold: the native addons (oxc-parser,
 * oxc-resolver, node-pty), the sandbox runtime (`srt`) and the canon. They are the app's resources,
 * in one folder, `metator-resources`. Run from a checkout or the npm package, nothing here applies:
 * everything is in `node_modules` and beside the sources.
 */

/** The variable that names the resources folder; the app and the launcher set it. */
export const RESOURCES_ENV = "METATOR_RESOURCES";
/** The folder's name, wherever the installation puts it. */
export const RESOURCES_DIR = "metator-resources";
/** Makes a compiled executable act as the `bun` it was built from (Bun's own switch). */
export const BE_BUN_ENV = "BUN_BE_BUN";

/** The native addons a compiled `metator` loads from the resources folder, by the package that needs them. */
export const NATIVE_ADDONS = {
  "oxc-parser": "oxc-parser.node",
  "oxc-resolver": "oxc-resolver.node",
} as const;
export type NativeAddon = keyof typeof NATIVE_ADDONS;

/**
 * Whether this program is a compiled executable: its code then lives in Bun's own file system
 * (`/$bunfs/root/…`, `B:\~BUN\root\…` on Windows), not on disk.
 */
export function isCompiled(main: string): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
}

/**
 * Where an installation puts the resources folder, from the executable's folder: beside it
 * (Windows, and a folder the compile script made), in the bundle's Resources (macOS), and in
 * `/usr/lib/MetatorAI` (Linux .deb and AppImage, where the executable is in `/usr/bin`).
 */
export function resourceCandidates(exeDir: string): string[] {
  return [
    join(exeDir, RESOURCES_DIR),
    join(exeDir, "..", "Resources", RESOURCES_DIR),
    join(exeDir, "..", "lib", "MetatorAI", RESOURCES_DIR),
  ];
}

/** The resources folder: `$METATOR_RESOURCES` when set, else the first candidate that holds a `native` folder. */
export function findResources(
  env: Readonly<Record<string, string | undefined>>,
  exeDir: string,
  exists: (path: string) => boolean,
): string | undefined {
  const given = env[RESOURCES_ENV];
  if (given !== undefined && given.trim() !== "") return given;
  return resourceCandidates(exeDir).find((dir) => exists(join(dir, "native")));
}

/** A native addon's file in the resources folder: one per platform and architecture (a universal macOS app has two). */
export function nativeAddonFile(
  resources: string,
  platform: string,
  arch: string,
  addon: NativeAddon,
): string {
  return join(resources, "native", `${platform}-${arch}`, NATIVE_ADDONS[addon]);
}

/** node-pty's package in the resources folder: its JavaScript, its native build, and on Windows ConPTY's programs. */
export const nodePtyDir = (resources: string): string => join(resources, "node-pty");
/** The sandbox runtime's command line in the resources folder (its package, bundled into one file). */
export const srtCliFile = (resources: string): string => join(resources, "sandbox-runtime", "dist", "cli.js");
/** The canon (agents, skills, workflows, rules) a compiled `metator` installs from. */
export const canonDir = (resources: string): string => join(resources, "canon");
/**
 * The Java parser's WebAssembly (ADR-0107): web-tree-sitter's runtime and tree-sitter-java's
 * grammar, in the resources folder's `wasm`. The same files on every platform.
 */
export const javaGrammarFiles = (
  resources: string,
): { readonly runtime: string; readonly language: string } => ({
  runtime: join(resources, "wasm", "web-tree-sitter.wasm"),
  language: join(resources, "wasm", "tree-sitter-java.wasm"),
});

/**
 * What the program changes in its own environment before anything runs, so every process it
 * starts (the daemon, a drive, a host session and the hooks in it) finds the same installation:
 * the resources folder and the canon by name, and the executable's own folder first on PATH, so
 * a hook's plain `metator` is this program. Nothing when not compiled.
 */
export function installationEnv(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly main: string;
  readonly exists: (path: string) => boolean;
  readonly delimiter: string;
  /** A program's path on PATH (`Bun.which`). */
  readonly which: (program: string) => string | null;
}): Record<string, string> {
  if (!isCompiled(o.main)) return {};
  const exeDir = dirname(o.execPath);
  const out: Record<string, string> = {};
  const resources = findResources(o.env, exeDir, o.exists);
  if (resources !== undefined) {
    out[RESOURCES_ENV] = resources;
    if (!o.env.METATOR_CANON) out.METATOR_CANON = canonDir(resources);
  }
  const path = o.env.PATH ?? o.env.Path ?? "";
  const entries = path.split(o.delimiter).filter((e) => e !== "");
  if (entries[0] !== exeDir) out.PATH = [exeDir, ...entries.filter((e) => e !== exeDir)].join(o.delimiter);
  // The Agent SDK's own Claude Code is a platform package a compiled executable does not ship: its
  // agents run the person's `claude` (they need it installed, as an interactive session does).
  if (!o.env[CLAUDE_EXECUTABLE_ENV]) {
    const claude = o.which("claude");
    if (claude) out[CLAUDE_EXECUTABLE_ENV] = claude;
  }
  return out;
}

/** The variable that names the folder of the Linux CLI bundles (`<arch>/metator-bundle.json`, ADR-0106). */
export const LINUX_BUNDLES_ENV = "METATOR_LINUX_BUNDLES";

/**
 * The Linux CLI bundles `metator devcontainer` copies into a container: `$METATOR_LINUX_BUNDLES`,
 * else the desktop app's `linux-cli` folder beside its resources (the Windows and macOS apps carry
 * it); undefined when there is none (a checkout, npm, the Linux app).
 */
export function linuxBundlesDir(
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
  main: string,
  exists: (path: string) => boolean,
): string | undefined {
  const given = env[LINUX_BUNDLES_ENV];
  if (given !== undefined && given.trim() !== "") return given;
  if (!isCompiled(main)) return undefined;
  const resources = findResources(env, dirname(execPath), exists);
  if (resources === undefined) return undefined;
  const dir = join(dirname(resources), "linux-cli");
  return exists(dir) ? dir : undefined;
}

/** The variable plugin-host-claude reads for the `claude` program its Agent SDK runs. */
export const CLAUDE_EXECUTABLE_ENV = "METATOR_CLAUDE_EXECUTABLE";

/**
 * This program's own command line, to start itself again (the daemon, a drive): the executable
 * alone when compiled (its argv[1] is a path inside the executable), else the runtime and the script.
 */
export function selfCommand(
  p: { readonly argv: readonly string[]; readonly execPath: string } = process,
  main: string = Bun.main,
): string[] {
  return isCompiled(main) ? [p.execPath] : [p.argv[0] as string, p.argv[1] as string];
}

/**
 * The paths of this installation as the composition root takes them: where node-pty and the
 * sandbox runtime are, and how the runtime runs (`BUN_BE_BUN=1` makes the executable a `bun`).
 * Empty when not compiled: node_modules has them.
 */
export function installationPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  execPath: string = process.execPath,
  main: string = Bun.main,
): {
  readonly nodePty?: string;
  readonly javaGrammar?: { readonly runtime: string; readonly language: string };
  readonly sandboxRuntime?: { readonly runtime: readonly string[]; readonly cli: string };
  readonly beBun?: <T>(f: () => T) => T;
} {
  if (!isCompiled(main)) return {};
  const resources = findResources(env, dirname(execPath), existsSync);
  // Without resources there is no runtime to name; doctor's isolation says where it looked.
  const where = resources ?? join(dirname(execPath), RESOURCES_DIR);
  return {
    ...(resources === undefined
      ? {}
      : { nodePty: nodePtyDir(resources), javaGrammar: javaGrammarFiles(resources) }),
    sandboxRuntime: { runtime: ["env", `${BE_BUN_ENV}=1`, execPath], cli: srtCliFile(where) },
    beBun: actingAsBun,
  };
}

/**
 * Runs `f` with this executable acting as `bun` for the processes `f` starts and only for them
 * (node-pty on Windows forks a helper script with the runtime when it kills a session).
 */
export function actingAsBun<T>(f: () => T): T {
  const was = process.env[BE_BUN_ENV];
  process.env[BE_BUN_ENV] = "1";
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env[BE_BUN_ENV];
    else process.env[BE_BUN_ENV] = was;
  }
}

/**
 * A native addon of a compiled `metator`, loaded from the resources folder. `scripts/compile-cli.ts`
 * makes the napi-rs loaders of oxc-parser and oxc-resolver return this instead of looking in
 * node_modules, which a compiled executable does not have. The loaders run when the program
 * starts: an addon that is not there must not stop every command, so it is a stand-in whose every
 * use throws why (`missingAddon`), and only the commands that parse say so.
 */
export function nativeAddon(addon: NativeAddon): unknown {
  const resources = findResources(process.env, dirname(process.execPath), existsSync);
  if (resources === undefined)
    return missingAddon(
      addon,
      `no ${RESOURCES_DIR} folder beside ${process.execPath} and ${RESOURCES_ENV} is not set`,
    );
  const file = nativeAddonFile(resources, process.platform, process.arch, addon);
  if (!existsSync(file)) return missingAddon(addon, `${file} does not exist`);
  return createRequire(import.meta.url)(file);
}

/** An addon that is not there: reading it gives functions, calling or constructing one throws why. */
export function missingAddon(addon: NativeAddon, why: string): Record<string, unknown> {
  const fail = function missing(): never {
    throw new Error(
      `${addon}'s native addon cannot load: ${why}. Reinstall the MetatorAI app, or set ${RESOURCES_ENV} to its ${RESOURCES_DIR} folder.`,
    );
  };
  return new Proxy({}, { get: (_t, key) => (key === "__napiBindingTarget" ? undefined : fail) });
}

/** Applies `installationEnv` to this process (main.ts, first thing). */
export function adoptInstallation(): void {
  Object.assign(
    process.env,
    installationEnv({
      env: process.env,
      execPath: process.execPath,
      main: Bun.main,
      exists: existsSync,
      delimiter,
      which: (program) => Bun.which(program),
    }),
  );
}
