import { copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, MetatorError, ok, type ProcessRunner, type Result, type WorkingPatches } from "@metator/core";

let counter = 0;
const scratchFile = (what: string) =>
  join(tmpdir(), `metator-${what}-${process.pid}-${Date.now()}-${counter++}`);

/**
 * WorkingPatches on the git CLI. A snapshot is a tree object written through an index of its own
 * (a copy of the real one, so unchanged files are not read again): the real index, HEAD, the
 * branches and the stash are never touched. A patch is `git diff --binary` between two trees;
 * whether it is still there, and taking it out, are `git apply -R`, checked before anything is
 * changed.
 */
export class GitWorkingPatches implements WorkingPatches {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
    /** Path prefixes that are never part of an edit (MetatorAI's own state, before it is gitignored). */
    private readonly own: readonly string[] = [],
  ) {}

  private git(argv: readonly string[], env?: Record<string, string>) {
    return this.runner.run({ argv: ["git", ...argv], cwd: this.root, ...(env ? { env } : {}) });
  }

  private failed(what: string, stderr: string): MetatorError {
    return new MetatorError("COMMAND_FAILED", `git ${what}: ${stderr.trim().split("\n")[0] ?? "failed"}`);
  }

  async snapshot(): Promise<Result<string, MetatorError>> {
    const index = scratchFile("index");
    try {
      const real = await this.git(["rev-parse", "--git-path", "index"]);
      if (real.exitCode !== 0) return err(this.failed("rev-parse", real.stderr));
      // No index yet (nothing was ever added): the snapshot starts empty.
      await copyFile(join(this.root, real.stdout.trim()), index).catch(() => undefined);
      const env = { GIT_INDEX_FILE: index };
      const added = await this.git(["add", "-A", "--", "."], env);
      if (added.exitCode !== 0) return err(this.failed("add", added.stderr));
      // MetatorAI's own state is never part of an edit, ignored or not (an exclude pathspec that
      // names an ignored path is refused by git, so it is taken out of the snapshot afterwards).
      if (this.own.length > 0) {
        const mine = await this.git(
          [
            "rm",
            "-r",
            "-q",
            "--cached",
            "--ignore-unmatch",
            "--",
            ...this.own.map((p) => p.replace(/\/$/, "")),
          ],
          env,
        );
        if (mine.exitCode !== 0) return err(this.failed("rm --cached", mine.stderr));
      }
      const tree = await this.git(["write-tree"], env);
      if (tree.exitCode !== 0) return err(this.failed("write-tree", tree.stderr));
      return ok(tree.stdout.trim());
    } finally {
      await rm(index, { force: true });
    }
  }

  async between(
    from: string,
    to: string,
  ): Promise<Result<{ readonly files: readonly string[]; readonly patch: string }, MetatorError>> {
    const names = await this.git(["diff", "--name-only", "-z", "--no-renames", from, to]);
    if (names.exitCode !== 0) return err(this.failed("diff", names.stderr));
    const files = names.stdout.split("\0").filter((f) => f !== "");
    if (files.length === 0) return ok({ files, patch: "" });
    const patch = await this.git([
      "diff",
      "--binary",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--full-index",
      from,
      to,
    ]);
    if (patch.exitCode !== 0) return err(this.failed("diff", patch.stderr));
    return ok({ files, patch: patch.stdout });
  }

  /** Runs `work` with the patch in a file git can read. */
  private async withPatch<T>(patch: string, work: (file: string) => Promise<T>): Promise<T> {
    const file = scratchFile("patch");
    await writeFile(file, patch);
    try {
      return await work(file);
    } finally {
      await rm(file, { force: true });
    }
  }

  /** The files a patch changes. */
  private async filesOf(file: string): Promise<Result<string[], MetatorError>> {
    const stat = await this.git(["apply", "--numstat", "-z", file]);
    if (stat.exitCode !== 0) return err(this.failed("apply --numstat", stat.stderr));
    // `<added>\t<removed>\t<path>\0` per file.
    return ok(
      stat.stdout
        .split("\0")
        .map((entry) => entry.split("\t").slice(2).join("\t"))
        .filter((f) => f !== ""),
    );
  }

  async holding(
    patch: string,
    where: "tree" | "index" | "tracked",
  ): Promise<Result<readonly string[], MetatorError>> {
    return this.withPatch(patch, async (file) => {
      const files = await this.filesOf(file);
      if (files.isErr()) return err(files.error);
      const held: string[] = [];
      for (const f of files.value) {
        const check = await this.git([
          "apply",
          "-R",
          "--check",
          ...(where === "index" ? ["--cached"] : []),
          `--include=${f}`,
          file,
        ]);
        if (check.exitCode !== 0) continue;
        // A new file nobody added is in the tree, and in no `commit -a`.
        if (where === "tracked" && (await this.git(["ls-files", "--error-unmatch", "--", f])).exitCode !== 0)
          continue;
        held.push(f);
      }
      return ok(held);
    });
  }

  async revert(patch: string): Promise<Result<void, MetatorError>> {
    return this.withPatch(patch, async (file) => {
      const check = await this.git(["apply", "-R", "--check", file]);
      if (check.exitCode !== 0) {
        const files = [
          ...check.stderr.matchAll(
            /^error: (.+): (?:patch does not apply|No such file or directory|already exists in working directory)$/gm,
          ),
        ].map((m) => m[1] as string);
        return err(
          new MetatorError(
            "COMMAND_FAILED",
            `the patch no longer applies${files.length > 0 ? ` (${[...new Set(files)].join(", ")} changed since)` : ""}`,
            { hint: "Nothing was changed. Take the debug lines out by hand, then drop the record again." },
          ),
        );
      }
      // What of it is staged, asked before the tree changes; taken out of the index after it.
      const staged = await this.holding(patch, "index");
      if (staged.isErr()) return err(staged.error);
      const reverted = await this.git(["apply", "-R", file]);
      if (reverted.exitCode !== 0) return err(this.failed("apply -R", reverted.stderr));
      for (const f of staged.value) {
        const unstaged = await this.git(["apply", "-R", "--cached", `--include=${f}`, file]);
        if (unstaged.exitCode !== 0) return err(this.failed("apply -R --cached", unstaged.stderr));
      }
      return ok(undefined);
    });
  }
}
