import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok, type Result, type Sandbox } from "@metator/core";

const GIT = [
  "git",
  "-c",
  "user.name=metator",
  "-c",
  "user.email=metator@localhost",
  "-c",
  "commit.gpgsign=false",
];

/**
 * Sandboxes in the system temp directory: the files, written and committed in a new git
 * repository (so MetatorAI's own commands work there as in any checkout) and linked with
 * `bun install`; `dispose` removes it.
 */
export class TempGitSandbox implements Sandbox {
  constructor(private readonly prefix = "metator-sandbox-") {}

  async create(
    files: Readonly<Record<string, string>>,
  ): Promise<Result<{ readonly root: string; dispose(): Promise<void> }, MetatorError>> {
    const root = await mkdtemp(join(tmpdir(), this.prefix));
    const dispose = () => rm(root, { recursive: true, force: true });
    // Like any checkout, the sandbox ignores installed packages and MetatorAI's working state.
    const all = { ".gitignore": "node_modules/\n.metator/\n", ...files };
    for (const [path, text] of Object.entries(all)) {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        await dispose();
        return err(MetatorError.usage(`${path} is outside the sandbox`));
      }
      await Bun.write(join(root, path), text);
    }
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      ["commit", "-q", "-m", "sandbox"],
    ]) {
      const r = Bun.spawnSync([...GIT, ...args], { cwd: root });
      if (r.exitCode !== 0) {
        await dispose();
        return err(
          new MetatorError("COMMAND_FAILED", `git ${args[0]} failed: ${r.stderr.toString().trim()}`),
        );
      }
    }
    // Linked like a developer's checkout, so imports by package name resolve to files. Offline and
    // best effort: a case whose dependencies need the network stays unlinked.
    if (files["package.json"] !== undefined)
      Bun.spawnSync(["bun", "install", "--offline"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    return ok({ root, dispose });
  }
}
