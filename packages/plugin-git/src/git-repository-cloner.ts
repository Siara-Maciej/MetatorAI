import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { err, MetatorError, ok, type RepositoryCloner, type Result } from "@metator/core";
import { simpleGit } from "simple-git";

const SHA = /^[0-9a-f]{40}$/;

/**
 * Other repositories on simple-git (ADR-0019, F7.3): the commit a ref points to (`ls-remote`),
 * and a checkout of exactly that commit in the cache, cloned once and reused. Repositories are
 * git URLs or local paths alike.
 */
export class GitRepositoryCloner implements RepositoryCloner {
  async resolve(repo: string, ref?: string): Promise<Result<string, MetatorError>> {
    if (ref && SHA.test(ref)) return ok(ref);
    try {
      const name = ref ?? "HEAD";
      const out = await simpleGit().listRemote([repo, name, `${name}^{}`]);
      const lines = out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length === 2);
      // An annotated tag's commit (`^{}`) wins over the tag object, then a branch, then anything else.
      const pick = (suffix: string) => lines.find(([, n]) => n === suffix || n?.endsWith(`/${suffix}`));
      const sha = (pick(`${name}^{}`) ?? pick(`heads/${name}`) ?? pick(name) ?? lines[0])?.[0];
      if (!sha || !SHA.test(sha))
        return err(MetatorError.notFound(`${ref ?? "the default branch"} in ${repo}`, { repo, ref }));
      return ok(sha);
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `Cannot reach ${repo}: ${(e as Error).message.split("\n")[0]}`, {
          hint: "Check the repository URL and your access, or set `system.roots` to a local checkout.",
        }),
      );
    }
  }

  /** Cloned next to `dir` and renamed into place once checked out, so `dir` is always complete. */
  async checkout(repo: string, sha: string, dir: string): Promise<Result<void, MetatorError>> {
    if (existsSync(dir)) return ok(undefined);
    const partial = `${dir}.partial-${process.pid}`;
    try {
      await mkdir(dirname(dir), { recursive: true });
      await rm(partial, { recursive: true, force: true });
      await simpleGit().clone(repo, partial, ["--quiet", "--no-checkout"]);
      await simpleGit(partial).checkout(["--quiet", sha]);
      await rename(partial, dir);
      return ok(undefined);
    } catch (e) {
      await rm(partial, { recursive: true, force: true });
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `Cannot clone ${repo} at ${sha.slice(0, 12)}: ${(e as Error).message.split("\n")[0]}`,
        ),
      );
    }
  }
}
