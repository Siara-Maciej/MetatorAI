import type { MetatorConfig } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import type { McpServers } from "../domain/mcp.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { declaresDependencies } from "../domain/worktree.ts";
import type { FileSystem, Vcs } from "../ports/index.ts";
import type { EnvironmentServices } from "./environments.ts";
import { emptyGateHint } from "./gate.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

/** ok: nothing to do · warn: a run works, but does less than it could · fail: a run cannot start. */
export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  readonly id:
    | "config"
    | "canon"
    | "git"
    | "commits"
    | "tree"
    | "host"
    | "workflows"
    | "gates"
    | "dependencies"
    | "environment"
    | "remote"
    | "mcp"
    | "runs";
  readonly status: ReadinessStatus;
  /** What this means for a run, in one sentence. */
  readonly message: string;
  /** The command or step that fixes it, when something is to be fixed. */
  readonly fix?: string;
}

export interface Readiness {
  /** No check failed: a run can start (warnings say what it will not do). */
  readonly ready: boolean;
  /** The checkout the checks looked at: the repository, or a worktree's path. */
  readonly place: string;
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessInput {
  /** Look at this worktree (a run's session) instead of the repository's checkout. */
  readonly worktree?: string;
}

/** The lockfile names the package manager whose install command a person runs. */
const INSTALL: readonly (readonly [string, string])[] = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
];

/**
 * `metator doctor` (P2): what a run here will and will not do, before it starts. Every test run
 * of the product on a repository without its dependencies installed ended with gates that checked
 * only rules: this says so up front, with the command that fixes it.
 */
export class CheckReadiness {
  constructor(
    private readonly fs: Pick<FileSystem, "exists"> & Partial<Pick<FileSystem, "read">>,
    private readonly paths: Pick<MetatorPaths, "installLock">,
    private readonly config: { readonly config: MetatorConfig; readonly source?: string | undefined },
    private readonly catalog: Pick<WorkflowCatalog, "scan">,
    private readonly vcs: Pick<Vcs, "remoteUrl" | "hasCommits">,
    /** Whether a repo-relative directory exists (`FileSystem` sees files only). */
    private readonly isDirectory: (path: string) => Promise<boolean>,
    private readonly worktrees: Pick<WorktreeRegistry, "get"> = {
      get: async (id) => err(MetatorError.notFound(`worktree ${id}`)),
    },
    private readonly services: Pick<EnvironmentServices, "status"> = {
      status: async () => err(MetatorError.notFound("environment")),
    },
    /** The MCP servers the agents get here and whether a command is on the PATH (T1). */
    private readonly mcp: {
      readonly servers: () => Promise<Result<McpServers, MetatorError>>;
      readonly hasCommand: (bin: string) => Promise<boolean>;
    } = { servers: async () => ok({}), hasCommand: async () => true },
    private readonly runs: Pick<RunRepository, "loadAll"> = {
      loadAll: async () => ({ runs: [], unreadable: [] }),
    },
    /** What only the machine knows: which AI hosts can start, and what is uncommitted (F3). */
    private readonly here: {
      /** The AI hosts that drive runs here (`hosts.targets`), and why one cannot start. */
      readonly hosts?: () => readonly { readonly id: string; readonly problem?: string | undefined }[];
      /** Tracked files with uncommitted changes in the checkout; undefined when git cannot say. */
      readonly modified?: () => Promise<readonly string[] | undefined>;
    } = {},
  ) {}

  async execute(input: ReadinessInput = {}): Promise<Result<Readiness, MetatorError>> {
    let place = ".";
    if (input.worktree) {
      const wt = await this.worktrees.get(input.worktree);
      if (wt.isErr()) return err(wt.error);
      place = wt.value.path;
    }
    const checks: ReadinessCheck[] = [
      this.config.source
        ? { id: "config", status: "ok", message: `configured by ${this.config.source}` }
        : {
            id: "config",
            status: "warn",
            message: "no metator.config: MetatorAI's defaults apply (no gates, every host)",
            fix: "metator init",
          },
      (await this.fs.exists(this.paths.installLock))
        ? { id: "canon", status: "ok", message: "agents, skills and workflows are installed" }
        : {
            id: "canon",
            status: "warn",
            message: "the agents and skills are not installed by MetatorAI here",
            fix: "metator setup",
          },
    ];
    // Only said when it fails: a directory git does not know, or a repository right after `git init`.
    const commits = await this.vcs.hasCommits?.();
    if (commits?.isErr() && commits.error.code === "NOT_FOUND")
      checks.push({
        id: "git",
        status: "fail",
        message: "not a git repository: a run's change, its review and its worktree need git",
        fix: "git init && git commit --allow-empty -m init",
      });
    if (commits?.isOk() && !commits.value)
      checks.push({
        id: "commits",
        status: "fail",
        message: "the repository has no commit yet: a run's worktree and its diff need one",
        fix: "git commit --allow-empty -m init",
      });
    const scan = await this.catalog.scan();
    checks.push(
      scan.workflows.length > 0
        ? {
            id: "workflows",
            status: "ok",
            message: `workflows: ${scan.workflows.map((w) => w.spec.id).join(", ")}`,
          }
        : {
            id: "workflows",
            status: "fail",
            message: "no workflow here: there is nothing a run could follow",
            fix: "metator setup",
          },
    );
    const gates = this.config.config.gates;
    checks.push(
      gates.full.length > 0 || gates.quick.length > 0
        ? {
            id: "gates",
            status: "ok",
            message: `gates: ${gates.full.length} full and ${gates.quick.length} quick step(s)`,
          }
        : {
            id: "gates",
            status: "warn",
            message: "no gates configured: a run's gates stage checks nothing",
            fix: this.config.source
              ? emptyGateHint("full", this.config.source)
              : "metator init (it proposes gates from the repository's scripts)",
          },
    );
    checks.push(...this.hosts());
    if (place === ".") checks.push(...(await this.tree()));
    checks.push(await this.dependencies(place));
    checks.push(await this.environment(input.worktree));
    checks.push(await this.mcpServers());
    const remote = await this.vcs.remoteUrl();
    checks.push(
      remote.isOk() && remote.value
        ? { id: "remote", status: "ok", message: `pushes go to ${remote.value}` }
        : {
            id: "remote",
            status: "warn",
            message: "no git remote: a run's publish stage cannot push its branch",
            fix: "git remote add origin <url>",
          },
    );
    // Said only when there is one: a run the overviews leave out, and the file to restore or delete.
    for (const u of (await this.runs.loadAll()).unreadable)
      checks.push({
        id: "runs",
        status: "warn",
        message: `run ${u.runId} cannot be read and is left out of the overviews (${u.message})`,
        fix: `restore ${u.file} (from git or a backup), or delete the run's directory`,
      });
    return ok({ ready: checks.every((c) => c.status !== "fail"), place, checks });
  }

  /**
   * The AI hosts that would drive a run: failing when none of them can start. One that cannot,
   * beside one that can, is said in the message and is no warning: `run drive` refuses it by name.
   */
  private hosts(): ReadinessCheck[] {
    const hosts = this.here.hosts?.();
    if (!hosts || hosts.length === 0) return [];
    const missing = hosts.filter((h) => h.problem !== undefined);
    const there = hosts.filter((h) => h.problem === undefined).map((h) => h.id);
    const why = missing.map((h) => `${h.id} (${h.problem})`).join(", ");
    if (there.length > 0)
      return [
        {
          id: "host",
          status: "ok",
          message: `AI hosts that can drive a run: ${there.join(", ")}${missing.length > 0 ? `; cannot start: ${why}` : ""}`,
        },
      ];
    return [
      {
        id: "host",
        status: "fail",
        message: `no AI host can start: ${why}; nothing would run a run's agents`,
        fix: "install the host's CLI, or name an installed host in hosts.targets of metator.config.yml",
      },
    ];
  }

  /** Uncommitted changes to tracked files: a run in a worktree starts without them. Said only when there are some. */
  private async tree(): Promise<ReadinessCheck[]> {
    const modified = await this.here.modified?.();
    if (!modified || modified.length === 0) return [];
    const shown = modified.slice(0, 3).join(", ");
    return [
      {
        id: "tree",
        status: "warn",
        message: `${modified.length} tracked file(s) have uncommitted changes (${shown}${modified.length > 3 ? ", …" : ""}): a run in a worktree starts from the last commit, without them; a run in this checkout mixes them into its change`,
        fix: "git commit -am <message>, or git stash",
      },
    ];
  }

  /** A Node project without node_modules: its tests, type checker and linters cannot run in a run. */
  private async dependencies(place: string): Promise<ReadinessCheck> {
    const at = (p: string) => (place === "." ? p : `${place}/${p}`);
    if (!(await this.fs.exists(at("package.json"))))
      return { id: "dependencies", status: "ok", message: "not a Node project: nothing to install" };
    // A package.json that lists nothing to install leaves no node_modules behind: nothing is missing (F5).
    const manifest = await this.fs.read?.(at("package.json"));
    if (manifest?.isOk() && !declaresDependencies(manifest.value))
      return {
        id: "dependencies",
        status: "ok",
        message: `package.json lists no dependencies${where(place)}: nothing to install`,
      };
    if (await this.isDirectory(at("node_modules")))
      return { id: "dependencies", status: "ok", message: `dependencies are installed${where(place)}` };
    let fix = "npm install";
    for (const [lock, command] of INSTALL)
      if (await this.fs.exists(at(lock))) {
        fix = command;
        break;
      }
    return {
      id: "dependencies",
      status: "warn",
      message: `dependencies are not installed${where(place)}: in a run, tests, the type checker and linters cannot run, so gates check only rules`,
      // A worktree gets them from the main checkout or the package manager in one command.
      fix: place === "." ? fix : "metator worktree setup --worktree <id>",
    };
  }

  /** Every configured MCP server starts from a command on the PATH or a URL (design/14 §2). */
  private async mcpServers(): Promise<ReadinessCheck> {
    const servers = await this.mcp.servers();
    if (servers.isErr()) return { id: "mcp", status: "warn", message: servers.error.message };
    const names = Object.keys(servers.value);
    if (names.length === 0) return { id: "mcp", status: "ok", message: "no MCP servers configured" };
    const missing: string[] = [];
    for (const name of names) {
      const command = servers.value[name]?.command;
      if (command !== undefined && !(await this.mcp.hasCommand(command)))
        missing.push(`${name} (${command})`);
    }
    if (missing.length === 0)
      return { id: "mcp", status: "ok", message: `MCP servers configured: ${names.join(", ")}` };
    return {
      id: "mcp",
      status: "warn",
      message: `MCP server command(s) not found: ${missing.join(", ")}; the agents start without them`,
      fix: "install the command, or fix `mcp:` in metator.config.yml or ~/.config/metator/options.yml",
    };
  }

  /** The application's services in the place, when the repository declares an environment. */
  private async environment(worktree: string | undefined): Promise<ReadinessCheck> {
    const status = await this.services.status(worktree ? { worktree } : {});
    if (status.isErr()) {
      if (status.error.code === "NOT_FOUND")
        return { id: "environment", status: "ok", message: "no environment file: no services to start" };
      return { id: "environment", status: "warn", message: status.error.message };
    }
    const running = status.value.filter((s) => s.status === "running").length;
    if (running === status.value.length)
      return {
        id: "environment",
        status: "ok",
        message: `services running: ${running} of ${status.value.length}`,
      };
    return {
      id: "environment",
      status: "warn",
      message: `services running: ${running} of ${status.value.length}: a run cannot reach the application`,
      fix: worktree ? `metator env up --worktree ${worktree}` : "metator env up",
    };
  }
}

const where = (place: string) => (place === "." ? "" : ` in ${place}`);

/** What a run feels of readiness: its tests and gates, its push. Config and canon are `metator doctor`'s. */
export const RUN_READINESS: readonly ReadinessCheck["id"][] = [
  "host",
  "tree",
  "gates",
  "dependencies",
  "environment",
  "remote",
];

/** One warning per check that is not ok (only the `only` checks, when given). */
export const readinessWarnings = (r: Readiness, only?: readonly ReadinessCheck["id"][]): string[] =>
  r.checks
    .filter((c) => c.status !== "ok" && (!only || only.includes(c.id)))
    .map((c) => `${c.id}: ${c.message}${c.fix ? ` (fix: ${c.fix})` : ""}`);

/**
 * Why a run cannot start here (F3), with the step that fixes it; undefined when it can. Git is
 * needed by every run (its change, its review). A worktree also needs a commit to branch from
 * (a run in the checkout of a repository right after `git init` still starts) and leaves
 * uncommitted changes behind, which a person must have decided.
 */
export function startRefusal(
  r: Readiness,
  opts: { readonly worktree: boolean; readonly allowDirty?: boolean | undefined },
): MetatorError | undefined {
  const failed = r.checks.find(
    (c) => c.status === "fail" && (c.id === "git" || (c.id === "commits" && opts.worktree)),
  );
  if (failed)
    return new MetatorError("CHECK_FAILED", `a run cannot start here: ${failed.message}`, {
      ...(failed.fix ? { hint: `Run \`${failed.fix}\`, then start the run again.` } : {}),
      details: { check: failed.id },
    });
  const tree = r.checks.find((c) => c.id === "tree" && c.status !== "ok");
  if (tree && opts.worktree && !opts.allowDirty)
    return new MetatorError("CHECK_FAILED", `the run would start without your changes: ${tree.message}`, {
      hint: "Commit them (`git commit -am <message>`) or put them away (`git stash`); to start from the last commit anyway, pass --allow-dirty.",
      details: { check: "tree" },
    });
  return undefined;
}
