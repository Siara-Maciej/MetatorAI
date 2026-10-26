import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BinResolver, ResolvedCommand } from "@metator/core";

/** The repo's pinned binaries win over PATH, and nothing is downloaded (unlike npx or bunx). */
export class NodeBinResolver implements BinResolver {
  constructor(private readonly root: string) {}

  async command(bin: string, args: readonly string[]): Promise<ResolvedCommand> {
    const local = join(this.root, "node_modules", ".bin", bin);
    return { argv: [existsSync(local) ? local : bin, ...args], cwd: this.root };
  }
}
