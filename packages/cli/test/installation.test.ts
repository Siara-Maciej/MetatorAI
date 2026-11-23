import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  actingAsBun,
  canonDir,
  findResources,
  installationEnv,
  installationPaths,
  isCompiled,
  missingAddon,
  nativeAddonFile,
  nodePtyDir,
  resourceCandidates,
  selfCommand,
  srtCliFile,
} from "../src/installation.ts";

const COMPILED = "/$bunfs/root/metator";
const SOURCE = "/home/me/MetatorAI/packages/cli/src/main.ts";

describe("a compiled metator finds its installation (ADR-0105)", () => {
  test("compiled is when the code lives in Bun's own file system, on Unix and Windows", () => {
    expect(isCompiled(COMPILED)).toBe(true);
    expect(isCompiled("B:\\~BUN\\root\\metator.exe")).toBe(true);
    expect(isCompiled("B:/~BUN/root/metator.exe")).toBe(true);
    expect(isCompiled(SOURCE)).toBe(false);
    expect(isCompiled("C:\\work\\~BUN\\x.ts")).toBe(false);
  });

  test("the resources folder: the variable wins, else beside the executable, in Resources, in /usr/lib/MetatorAI", () => {
    const exe = "/opt/app/bin";
    expect(resourceCandidates(exe)).toEqual([
      join(exe, "metator-resources"),
      join(exe, "..", "Resources", "metator-resources"),
      join(exe, "..", "lib", "MetatorAI", "metator-resources"),
    ]);
    const deb = join("/usr/bin", "..", "lib", "MetatorAI", "metator-resources");
    const there = (dir: string) => (p: string) => p === join(dir, "native");
    expect(findResources({}, "/usr/bin", there(deb))).toBe(deb);
    expect(findResources({}, "/usr/bin", () => false)).toBeUndefined();
    expect(findResources({ METATOR_RESOURCES: "/given" }, "/usr/bin", there(deb))).toBe("/given");
    // An empty variable is no folder.
    expect(findResources({ METATOR_RESOURCES: " " }, "/usr/bin", there(deb))).toBe(deb);
  });

  test("each addon is a file per platform and architecture; node-pty, srt and the canon are folders in it", () => {
    expect(nativeAddonFile("/r", "darwin", "arm64", "oxc-parser")).toBe(
      join("/r", "native", "darwin-arm64", "oxc-parser.node"),
    );
    expect(nativeAddonFile("/r", "linux", "x64", "oxc-resolver")).toBe(
      join("/r", "native", "linux-x64", "oxc-resolver.node"),
    );
    expect(nodePtyDir("/r")).toBe(join("/r", "node-pty"));
    expect(srtCliFile("/r")).toBe(join("/r", "sandbox-runtime", "dist", "cli.js"));
    expect(canonDir("/r")).toBe(join("/r", "canon"));
  });

  test("compiled: the resources and the canon are named, and the executable's folder goes first on PATH once", () => {
    const resources = join("/app", "metator-resources");
    const exists = (p: string) => p === join(resources, "native");
    const env = installationEnv({
      env: { PATH: "/usr/bin:/app:/bin" },
      execPath: "/app/metator",
      main: COMPILED,
      exists,
      delimiter: ":",
      which: (p) => (p === "claude" ? "/usr/local/bin/claude" : null),
    });
    expect(env).toEqual({
      METATOR_RESOURCES: resources,
      METATOR_CANON: join(resources, "canon"),
      PATH: "/app:/usr/bin:/bin",
      METATOR_CLAUDE_EXECUTABLE: "/usr/local/bin/claude",
    });
    // Already first: PATH is left as it is; a canon given by the person is kept.
    expect(
      installationEnv({
        env: { PATH: "/app:/bin", METATOR_CANON: "/mine", METATOR_CLAUDE_EXECUTABLE: "/mine/claude" },
        execPath: "/app/metator",
        main: COMPILED,
        exists,
        delimiter: ":",
        which: () => "/elsewhere/claude",
      }),
    ).toEqual({ METATOR_RESOURCES: resources });
    // Windows names it Path, and separates with a semicolon.
    expect(
      installationEnv({
        env: { Path: "C:\\Windows" },
        execPath: "/app/metator",
        main: COMPILED,
        exists: () => false,
        delimiter: ";",
        which: () => null,
      }),
    ).toEqual({ PATH: "/app;C:\\Windows" });
  });

  test("run from the sources nothing changes", () => {
    expect(
      installationEnv({
        env: { PATH: "/bin" },
        execPath: "/bun",
        main: SOURCE,
        exists: () => true,
        delimiter: ":",
        which: () => "/bin/claude",
      }),
    ).toEqual({});
    expect(installationPaths({ METATOR_RESOURCES: "/r" }, "/bun", SOURCE)).toEqual({});
  });

  test("compiled, node-pty and the sandbox runtime come from the resources, the runtime being the executable as bun", () => {
    const paths = installationPaths({ METATOR_RESOURCES: "/r" }, "/app/metator", COMPILED);
    expect(paths.nodePty).toBe(join("/r", "node-pty"));
    expect(paths.sandboxRuntime).toEqual({
      runtime: ["env", "BUN_BE_BUN=1", "/app/metator"],
      cli: join("/r", "sandbox-runtime", "dist", "cli.js"),
    });
    expect(paths.beBun).toBe(actingAsBun);
    // No resources: no node-pty, and the sandbox runtime where it was looked for (doctor says it is not there).
    const none = installationPaths({}, "/nowhere/metator", COMPILED);
    expect(none.nodePty).toBeUndefined();
    expect(none.sandboxRuntime?.cli).toBe(
      join("/nowhere", "metator-resources", "sandbox-runtime", "dist", "cli.js"),
    );
  });

  test("acting as bun holds only while the function runs, and the variable is as it was after", () => {
    const was = process.env.BUN_BE_BUN;
    delete process.env.BUN_BE_BUN;
    expect(actingAsBun(() => process.env.BUN_BE_BUN)).toBe("1");
    expect(process.env.BUN_BE_BUN).toBeUndefined();
    expect(() =>
      actingAsBun(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.env.BUN_BE_BUN).toBeUndefined();
    process.env.BUN_BE_BUN = "0";
    actingAsBun(() => undefined);
    expect(process.env.BUN_BE_BUN).toBe("0");
    if (was === undefined) delete process.env.BUN_BE_BUN;
    else process.env.BUN_BE_BUN = was;
  });

  test("a missing addon does not stop the program: using it throws why, with the fix", () => {
    const addon = missingAddon("oxc-parser", "no folder") as {
      parseSync: () => void;
      __napiBindingTarget?: string;
    };
    expect(addon.__napiBindingTarget).toBeUndefined();
    expect(() => addon.parseSync()).toThrow("oxc-parser's native addon cannot load: no folder");
    expect(() => addon.parseSync()).toThrow("METATOR_RESOURCES");
  });

  test("the program starts itself again as the executable alone when compiled, else runtime and script", () => {
    const p = { argv: ["bun", "/$bunfs/root/metator", "serve"], execPath: "/app/metator" };
    expect(selfCommand(p, COMPILED)).toEqual(["/app/metator"]);
    expect(
      selfCommand({ argv: ["/usr/bin/bun", SOURCE, "serve"], execPath: "/usr/bin/bun" }, SOURCE),
    ).toEqual(["/usr/bin/bun", SOURCE]);
  });
});
