import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { declaresDependencies, LOCKFILES, type WorktreeEntry } from "../domain/worktree.ts";
import type { FileSystem, PackageManager, ProcessRunner, TreeCopier } from "../ports/index.ts";
import type { EnvironmentServices, ServiceReport } from "./environments.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

/** How long an install may take. */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

export interface SetupWorktreeInput {
  readonly worktree?: string;
  /** The run whose worktree to set up (default: the latest run with one). */
  readonly run?: string;
  /** Also start the worktree's services (`env up --worktree`), when the repository has an environment. */
  readonly up?: boolean;
}

export interface SetupReport {
  readonly worktree: string;
  readonly path: string;
  /**
   * reused: the main checkout's node_modules copied (lockfiles equal) · installed: the package
   * manager ran · present: already there · none: not a Node project, or one whose package.json
   * lists nothing to install.
   */
  readonly dependencies: "reused" | "installed" | "present" | "none";
  /** Directories copied, or the command run. */
  readonly detail?: string;
  readonly ms: number;
  /** Services started with `up`; absent without `up` or without an environment file. */
  readonly services?: readonly ServiceReport[];
}

/**
 * `worktree setup` (P9): a run's checkout made able to run its tests, type checker and linters.
 * Every test run of the product on a fresh worktree found no node_modules there, so gates checked
 * only rules. The main checkout's node_modules are copied (copy-on-write where the disk can) when
 * the lockfiles are the same in both; otherwise the repository's package manager installs.
 */
export class SetupWorktree {
  constructor(
    private readonly fs: Pick<FileSystem, "exists" | "read">,
    private readonly registry: Pick<WorktreeRegistry, "all" | "get">,
    private readonly runs: Pick<RunRepository, "load" | "resolveId">,
    private readonly packages: Pick<PackageManager, "installCommand">,
    private readonly process: ProcessRunner,
    private readonly copier: TreeCopier,
    private readonly services: Pick<EnvironmentServices, "up">,
    private readonly where: {
      readonly root: string;
      /** Whether a repo-relative directory exists (`FileSystem` sees files only). */
      readonly isDirectory: (path: string) => Promise<boolean>;
      /** Workspace package directories, repo-relative, whose node_modules come along with the root's. */
      readonly workspaces: () => Promise<readonly string[]>;
      readonly now: () => number;
    },
  ) {}

  async execute(input: SetupWorktreeInput): Promise<Result<SetupReport, MetatorError>> {
    const started = this.where.now();
    const entry = await this.target(input);
    if (entry.isErr()) return err(entry.error);
    const wt = entry.value;
    const deps = await this.dependencies(wt.path);
    if (deps.isErr()) return err(deps.error);
    let services: readonly ServiceReport[] | undefined;
    if (input.up) {
      const up = await this.services.up({ services: [], worktree: wt.id });
      // No environment file: nothing to start, and not a failure of the setup.
      if (up.isErr() && up.error.code !== "NOT_FOUND") return err(up.error);
      if (up.isOk()) services = up.value;
    }
    return ok({
      worktree: wt.id,
      path: wt.path,
      ...deps.value,
      ms: Math.max(0, this.where.now() - started),
      ...(services ? { services } : {}),
    });
  }

  private async target(input: SetupWorktreeInput): Promise<Result<WorktreeEntry, MetatorError>> {
    if (input.worktree) return this.registry.get(input.worktree);
    const id = await this.runs.resolveId(input.run);
    if (id.isErr()) return err(id.error);
    const record = await this.runs.load(id.value);
    if (record.isErr()) return err(record.error);
    if (!record.value.worktree)
      return err(
        MetatorError.usage(
          `run ${id.value} works in your checkout, not in a worktree: there is nothing to set up`,
          "Start a run with `metator run init --worktree`, or name a worktree with --worktree <id>.",
        ),
      );
    return this.registry.get(record.value.worktree.id);
  }

  private async dependencies(
    path: string,
  ): Promise<Result<Pick<SetupReport, "dependencies" | "detail">, MetatorError>> {
    if (!(await this.fs.exists(`${path}/package.json`))) return ok({ dependencies: "none" });
    if (await this.where.isDirectory(`${path}/node_modules`)) return ok({ dependencies: "present" });
    // Nothing to install: an install would only leave a lockfile in the run's change (F5).
    const manifest = await this.fs.read(`${path}/package.json`);
    if (manifest.isOk() && !declaresDependencies(manifest.value))
      return ok({ dependencies: "none", detail: "package.json lists no dependencies" });
    if ((await this.sameLockfiles(path)) && (await this.where.isDirectory("node_modules"))) {
      const copied: string[] = [];
      for (const dir of ["", ...(await this.where.workspaces())]) {
        const rel = dir === "" ? "node_modules" : `${dir}/node_modules`;
        if (!(await this.where.isDirectory(rel))) continue;
        const r = await this.copier.copy(`${this.where.root}/${rel}`, `${this.where.root}/${path}/${rel}`);
        if (r.isErr()) return err(r.error);
        if (r.value) copied.push(rel);
      }
      return ok({ dependencies: "reused", detail: copied.join(", ") });
    }
    const command = await this.packages.installCommand(`${this.where.root}/${path}`);
    if (command.isErr()) return err(command.error);
    const r = await this.process.run(command.value, { timeoutMs: INSTALL_TIMEOUT_MS });
    const line = command.value.argv.join(" ");
    if (r.exitCode !== 0)
      return err(
        new MetatorError("COMMAND_FAILED", `${line} exited with ${r.exitCode} in ${path}`, {
          hint: "Run it there yourself, then `metator doctor --worktree <id>`.",
          details: { output: `${r.stdout}${r.stderr}`.split("\n").slice(-20).join("\n") },
        }),
      );
    return ok({ dependencies: "installed", detail: line });
  }

  /** Every lockfile the main checkout has, byte for byte the same in the worktree (and at least one). */
  private async sameLockfiles(path: string): Promise<boolean> {
    let any = false;
    for (const lock of LOCKFILES) {
      const [main, here] = await Promise.all([this.readOr(lock), this.readOr(`${path}/${lock}`)]);
      if (main === undefined && here === undefined) continue;
      if (main !== here) return false;
      any = true;
    }
    return any;
  }

  private async readOr(path: string): Promise<string | undefined> {
    if (!(await this.fs.exists(path))) return undefined;
    return (await this.fs.read(path)).unwrapOr(undefined);
  }
}
