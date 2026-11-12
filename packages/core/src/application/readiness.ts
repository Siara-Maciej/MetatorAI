import type { MetatorConfig } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import type { McpServers } from "../domain/mcp.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { FileSystem, Vcs } from "../ports/index.ts";
import type { EnvironmentServices } from "./environments.ts";
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
    private readonly fs: Pick<FileSystem, "exists">,
    private readonly paths: Pick<MetatorPaths, "installLock">,
    private readonly config: { readonly config: MetatorConfig; readonly source?: string | undefined },
    private readonly catalog: Pick<WorkflowCatalog, "scan">,
    private readonly vcs: Pick<Vcs, "remoteUrl">,
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
            fix: "metator init (it proposes gates from the repository's scripts)",
          },
    );
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

  /** A Node project without node_modules: its tests, type checker and linters cannot run in a run. */
  private async dependencies(place: string): Promise<ReadinessCheck> {
    const at = (p: string) => (place === "." ? p : `${place}/${p}`);
    if (!(await this.fs.exists(at("package.json"))))
      return { id: "dependencies", status: "ok", message: "not a Node project: nothing to install" };
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
