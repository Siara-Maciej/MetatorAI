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
