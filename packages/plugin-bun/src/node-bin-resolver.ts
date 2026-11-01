import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BinResolver, ResolvedCommand } from "@metator/core";

/** The repo's pinned binaries win over PATH, and nothing is downloaded (unlike npx or bunx). */
export class NodeBinResolver implements BinResolver {
  constructor(private readonly root: string) {}

  async command(bin: string, args: readonly string[]): Promise<ResolvedCommand> {
    const local = join(this.root, "node_modules", ".bin", bin);
    // A Node project whose dependencies are not installed: the binary is its own pinned one, not
    // another version from PATH that would fail (or pass) for reasons of its own. It is reported
    // as not found, which says to install first.
    const uninstalled =
      existsSync(join(this.root, "package.json")) && !existsSync(join(this.root, "node_modules"));
    return { argv: [existsSync(local) || uninstalled ? local : bin, ...args], cwd: this.root };
  }
}
