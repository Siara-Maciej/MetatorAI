import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BinResolver, ResolvedCommand } from "@metator/core";

/**
 * What a Node project whose dependencies are not installed runs: `pinned` is its own binary path
 * (reported as not found, which says to install first, never another version from PATH that
 * would fail or pass for reasons of its own); `path` is whatever PATH has.
 */
export type WhenUninstalled = "pinned" | "path";

/** The repo's pinned binaries win over PATH, and nothing is downloaded (unlike npx or bunx). */
export class NodeBinResolver implements BinResolver {
  constructor(
    private readonly root: string,
    private readonly whenUninstalled: WhenUninstalled = "pinned",
  ) {}

  async command(bin: string, args: readonly string[]): Promise<ResolvedCommand> {
    const local = join(this.root, "node_modules", ".bin", bin);
    const uninstalled =
      this.whenUninstalled === "pinned" &&
      existsSync(join(this.root, "package.json")) &&
      !existsSync(join(this.root, "node_modules"));
    return { argv: [existsSync(local) || uninstalled ? local : bin, ...args], cwd: this.root };
  }
}
