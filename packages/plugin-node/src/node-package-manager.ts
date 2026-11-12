import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type DetectedPackageManager,
  err,
  MetatorError,
  ok,
  type PackageManager,
  type PackageManagerDetector,
  type ResolvedCommand,
  type Result,
} from "@metator/core";
import { type AgentName, detect, LOCKS, resolveCommand } from "package-manager-detector";

/** Each tool's flag for "install, and write no lockfile". */
const NO_LOCKFILE: Readonly<Record<string, readonly string[]>> = {
  npm: ["--no-package-lock"],
  pnpm: ["--no-lockfile"],
  yarn: ["--no-lockfile"],
  bun: ["--no-save"],
};

/**
 * Package manager via package-manager-detector (ADR-0028): detection from the `packageManager`
 * field, devEngines and lockfiles (never above the repository root), and script commands with
 * each tool's argument rules (`npm run x -- a.ts`, `bun run x a.ts`).
 */
export class NodePackageManager implements PackageManagerDetector, PackageManager {
  private detected: Promise<Result<DetectedPackageManager | undefined, MetatorError>> | undefined;

  constructor(private readonly root: string) {}

  detect(): Promise<Result<DetectedPackageManager | undefined, MetatorError>> {
    this.detected ??= this.run();
    return this.detected;
  }

  async scriptCommand(
    script: string,
    args: readonly string[],
  ): Promise<Result<ResolvedCommand, MetatorError>> {
    const pm = await this.detect();
    if (pm.isErr()) return err(pm.error);
    // No signal at all: npm is what every Node installation has.
    const agent = (pm.value?.name ?? "npm") as AgentName;
    const resolved = resolveCommand(agent, "run", [script, ...args]);
    if (!resolved) return err(new MetatorError("INTERNAL", `No run command for package manager ${agent}`));
    return ok({ argv: [resolved.command, ...resolved.args], cwd: this.root });
  }

  async installCommand(cwd: string): Promise<Result<ResolvedCommand, MetatorError>> {
    const pm = await this.detect();
    if (pm.isErr()) return err(pm.error);
    const agent = (pm.value?.name ?? "npm") as AgentName;
    // With a lockfile, the install that changes nothing in it; without one, an install that writes
    // none: a lockfile the project does not have must not appear in a run's change (F5).
    const locked = (pm.value?.lockfiles.length ?? 0) > 0;
    const resolved = resolveCommand(agent, locked ? "frozen" : "install", []);
    if (!resolved)
      return err(new MetatorError("INTERNAL", `No install command for package manager ${agent}`));
    // Only yarn 1 has the flag; a later yarn would refuse it.
    const classic = agent !== "yarn" || /^1\./.test(pm.value?.version ?? "");
    const noLockfile = locked || !classic ? [] : (NO_LOCKFILE[agent] ?? []);
    return ok({ argv: [resolved.command, ...resolved.args, ...noLockfile], cwd });
  }

  async workspacesCommand(script: string): Promise<Result<ResolvedCommand, MetatorError>> {
    const pm = await this.detect();
    if (pm.isErr()) return err(pm.error);
    const name = pm.value?.name ?? "npm";
    // Each tool's own way to run a script in every workspace package that has one.
    const berry = name === "yarn" && !/^1\./.test(pm.value?.version ?? "1.");
    const argv: Record<string, readonly string[]> = {
      npm: ["npm", "run", script, "--workspaces", "--if-present"],
      pnpm: ["pnpm", "-r", "--if-present", "run", script],
      bun: ["bun", "run", "--filter", "*", script],
      yarn: berry
        ? ["yarn", "workspaces", "foreach", "-A", "run", script]
        : ["yarn", "workspaces", "run", script],
    };
    const command = argv[name];
    if (!command)
      return err(new MetatorError("INTERNAL", `No workspaces command for package manager ${name}`));
    return ok({ argv: [...command], cwd: this.root });
  }

  private async run(): Promise<Result<DetectedPackageManager | undefined, MetatorError>> {
    try {
      const found = await detect({ cwd: this.root, stopDir: this.root });
      const lockfiles = Object.keys(LOCKS)
        .filter((f) => !f.endsWith("-workspace.yaml") && existsSync(join(this.root, f)))
        .sort();
      if (!found) return ok(undefined); // detect() already looks at every lockfile
      return ok({ name: found.name, ...(found.version ? { version: found.version } : {}), lockfiles });
    } catch (e) {
      return err(
        new MetatorError("INVALID_CONFIG", `Cannot detect the package manager: ${(e as Error).message}`),
      );
    }
  }
}
