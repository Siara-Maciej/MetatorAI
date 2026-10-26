import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, MetatorError, ok, type Result, type RevisionReader, type Vcs } from "@metator/core";
import parseDiff from "parse-diff";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Vcs adapter on simple-git (ADR-0019): the library spawns git, parses `status` and `diff`
 * and turns failures into errors; this class only maps them to MetatorError. "Changed" means everything
 * that differs from the merge base with `base`: committed on the branch, staged, unstaged,
 * deleted and untracked (non-ignored) files. Paths are repo-relative.
 */
export class GitVcs implements Vcs, RevisionReader {
  private client: SimpleGit | undefined;

  constructor(private readonly root: string) {}

  async changedFiles(base: string): Promise<Result<readonly string[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const status = await git.value.status();
      // No commits yet: everything staged or untracked is new.
      if (!(await this.hasCommits(git.value))) return ok(sortedUnique(status.files.map((f) => f.path)));
      const ref = await this.mergeBase(git.value, base);
      if (ref.isErr()) return err(ref.error);
      // --no-renames: a rename counts under both paths, the old path's importers are affected too.
      const diff = (await git.value.diffSummary(["--no-renames", ref.value])).files.map((f) => f.file);
      return ok(sortedUnique([...diff, ...status.not_added]));
    });
  }

  async readAt(base: string, path: string): Promise<Result<string | undefined, MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      if (!(await this.hasCommits(git.value))) return ok(undefined);
      const ref = await this.mergeBase(git.value, base);
      if (ref.isErr()) return err(ref.error);
      const object = `${ref.value}:${path}`;
      const exists = await git.value
        .raw(["cat-file", "-e", object])
        .then(() => true)
        .catch(() => false);
      return ok(exists ? await git.value.show([object]) : undefined);
    });
  }

  async addedLines(base: string): Promise<Result<ReadonlyMap<string, readonly number[]>, MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const out = new Map<string, number[]>();
      const status = await git.value.status();
      if (await this.hasCommits(git.value)) {
        const ref = await this.mergeBase(git.value, base);
        if (ref.isErr()) return err(ref.error);
        for (const file of parseDiff(await git.value.raw(["diff", "--no-renames", "-U0", ref.value]))) {
          if (!file.to || file.to === "/dev/null") continue;
          const lines = file.chunks.flatMap((c) =>
            c.changes.flatMap((ch) => (ch.type === "add" ? [ch.ln] : [])),
          );
          if (lines.length > 0) out.set(file.to, lines);
        }
      }
      // Untracked files are new in full; git diff does not list them.
      for (const path of status.not_added) {
        if (!existsSync(join(this.root, path))) continue;
        const text = await Bun.file(join(this.root, path)).text();
        const count = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
        out.set(
          path,
          Array.from({ length: count }, (_, i) => i + 1),
        );
      }
      return ok(new Map([...out].sort(([a], [b]) => a.localeCompare(b))));
    });
  }

  async listFiles(): Promise<Result<readonly string[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const files = splitZ(await git.value.raw([...LS_FILES, "--cached", "--others"]));
      // Tracked files deleted in the working tree are still listed by --cached; drop them.
      const gone = new Set(splitZ(await git.value.raw([...LS_FILES, "--deleted"])));
      return ok(sortedUnique(files.filter((f) => !gone.has(f))));
    });
  }

  async remoteUrl(): Promise<Result<string | undefined, MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const remotes = await git.value.getRemotes(true);
      const remote = remotes.find((r) => r.name === "origin") ?? remotes[0];
      return ok(remote?.refs.fetch || undefined);
    });
  }

  private async repo(): Promise<Result<SimpleGit, MetatorError>> {
    const notFound = () =>
      err(
        new MetatorError("NOT_FOUND", `Not a git repository: ${this.root}`, {
          hint: "Run inside a git checkout.",
        }),
      );
    // simple-git refuses to start in a missing directory; that is "not a repository" too.
    if (!existsSync(this.root)) return notFound();
    this.client ??= simpleGit({
      baseDir: this.root,
      config: ["core.quotepath=false"],
      timeout: { block: 30_000 },
    });
    const inside = await this.client.checkIsRepo().catch(() => false);
    return inside ? ok(this.client) : notFound();
  }

  /** The commit `base` and HEAD share: what "changed since base" is measured against. */
  private async mergeBase(git: SimpleGit, base: string): Promise<Result<string, MetatorError>> {
    if (base === "HEAD") return ok("HEAD");
    const mergeBase = await git.raw(["merge-base", base, "HEAD"]).catch(() => undefined);
    if (!mergeBase?.trim()) {
      return err(
        MetatorError.usage(
          `Unknown base ref "${base}"`,
          "Use a branch, tag or commit that shares history with HEAD.",
        ),
      );
    }
    return ok(mergeBase.trim());
  }

  private async hasCommits(git: SimpleGit): Promise<boolean> {
    // Not `--quiet`: git would then fail without stderr, which simple-git reports as success.
    return git
      .revparse(["--verify", "HEAD"])
      .then(() => true)
      .catch(() => false);
  }

  private async attempt<T>(work: () => Promise<Result<T, MetatorError>>): Promise<Result<T, MetatorError>> {
    try {
      return await work();
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `git failed: ${(e as Error).message.trim().slice(0, 500)}`),
      );
    }
  }
}

const LS_FILES = ["ls-files", "-z", "--exclude-standard"];

function splitZ(out: string): string[] {
  return out.split("\0").filter((p) => p !== "");
}

function sortedUnique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
}
