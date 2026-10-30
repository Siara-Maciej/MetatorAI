import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BranchCommit,
  type BranchHistory,
  type ChangeHistory,
  type ChangePatch,
  err,
  MetatorError,
  ok,
  type Result,
  type RevisionReader,
  type Vcs,
} from "@metator/core";
import parseDiff from "parse-diff";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Vcs adapter on simple-git (ADR-0019): the library spawns git, parses `status` and `diff`
 * and turns failures into errors; this class only maps them to MetatorError. "Changed" means everything
 * that differs from the merge base with `base`: committed on the branch, staged, unstaged,
 * deleted and untracked (non-ignored) files. Paths are repo-relative.
 */
export class GitVcs implements Vcs, RevisionReader, ChangeHistory, BranchHistory, ChangePatch {
  private client: SimpleGit | undefined;

  constructor(
    private readonly root: string,
    /** Path prefixes that are never a change (MetatorAI's own state, before it is gitignored). */
    private readonly own: readonly string[] = [],
  ) {}

  async changedFiles(base: string): Promise<Result<readonly string[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const status = await git.value.status();
      // No commits yet: everything staged or untracked is new.
      const mine = (f: string) => !this.own.some((p) => f.startsWith(p));
      if (!(await this.hasCommits(git.value)))
        return ok(sortedUnique(status.files.map((f) => f.path)).filter(mine));
      const ref = await this.mergeBase(git.value, base);
      if (ref.isErr()) return err(ref.error);
      // --no-renames: a rename counts under both paths, the old path's importers are affected too.
      const diff = (await git.value.diffSummary(["--no-renames", ref.value])).files.map((f) => f.file);
      return ok(sortedUnique([...diff, ...status.not_added]).filter(mine));
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

  async lastChanged(): Promise<Result<ReadonlyMap<string, string>, MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const out = new Map<string, string>();
      if (!(await this.hasCommits(git.value))) return ok(out);
      // Newest commit first: the first date seen for a path is its last change.
      let date = "";
      for (const line of (
        await git.value.raw(["log", "--no-renames", "--format=%x01%cI", "--name-only"])
      ).split("\n")) {
        if (line.startsWith("\u0001")) date = line.slice(1);
        else if (line !== "" && !out.has(line)) out.set(line, date);
      }
      return ok(out);
    });
  }

  async commits(limit: number): Promise<Result<readonly (readonly string[])[], MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      if (!(await this.hasCommits(git.value))) return ok([]);
      const out: string[][] = [];
      for (const line of (
        await git.value.raw([
          "log",
          `-n${Math.max(1, Math.floor(limit))}`,
          "--no-renames",
          "--format=%x01",
          "--name-only",
        ])
      ).split("\n")) {
        if (line.startsWith("\u0001")) out.push([]);
        else if (line !== "") out.at(-1)?.push(line);
      }
      return ok(out);
    });
  }

  async patch(base: string, files?: readonly string[]): Promise<Result<string, MetatorError>> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const status = await git.value.status();
      const wanted = (f: string) => (!files || files.includes(f)) && !this.own.some((p) => f.startsWith(p));
      const parts: string[] = [];
      if (await this.hasCommits(git.value)) {
        const ref = await this.mergeBase(git.value, base);
        if (ref.isErr()) return err(ref.error);
        const paths = files ? [...files] : [];
        // No external diff driver or textconv: a repository's config cannot run a program here.
        const text = await git.value.raw([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ref.value,
          "--",
          ...paths,
        ]);
        if (text) parts.push(text.trimEnd());
      }
      for (const f of status.not_added.filter(wanted).sort()) {
        const path = join(this.root, f);
        if (!existsSync(path)) continue;
        const lines = readFileSync(path, "utf8").replace(/\n$/, "").split("\n");
        parts.push(
          [
            `diff --git a/${f} b/${f}`,
            "new file",
            "--- /dev/null",
            `+++ b/${f}`,
            `@@ -0,0 +1,${lines.length} @@`,
          ]
            .concat(lines.map((l) => `+${l}`))
            .join("\n"),
        );
      }
      return ok(parts.length > 0 ? `${parts.join("\n")}\n` : "");
    });
  }

  async branch(base: string): ReturnType<BranchHistory["branch"]> {
    const git = await this.repo();
    if (git.isErr()) return err(git.error);
    return this.attempt(async () => {
      const status = await git.value.status();
      const uncommitted = !status.isClean();
      const branch = status.detached ? null : status.current;
      if (!(await this.hasCommits(git.value)))
        return ok({ branch, head: null, mergeBase: null, commits: [] as BranchCommit[], uncommitted });
      const head = (await git.value.revparse(["HEAD"])).trim();
      const ref = await this.mergeBase(git.value, base);
      if (ref.isErr()) return err(ref.error);
      const mergeBase = ref.value === "HEAD" ? head : ref.value;
      const commits: BranchCommit[] = [];
      for (const line of (
        await git.value.raw(["log", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", `${mergeBase}..HEAD`])
      ).split("\n")) {
        const [sha, author, email, date, subject] = line.split("\u001f");
        if (sha && author !== undefined && email !== undefined && date !== undefined)
          commits.push({ sha, author, email, date, subject: subject ?? "" });
      }
      return ok({ branch, head, mergeBase, commits, uncommitted });
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
