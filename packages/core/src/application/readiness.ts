import type { MetatorConfig } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { ok, type Result } from "../domain/result.ts";
import type { FileSystem, Vcs } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

/** ok: nothing to do · warn: a run works, but does less than it could · fail: a run cannot start. */
export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  readonly id: "config" | "canon" | "workflows" | "gates" | "dependencies" | "remote";
  readonly status: ReadinessStatus;
  /** What this means for a run, in one sentence. */
  readonly message: string;
  /** The command or step that fixes it, when something is to be fixed. */
  readonly fix?: string;
}

export interface Readiness {
  /** No check failed: a run can start (warnings say what it will not do). */
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
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
    /** Whether the repository has a node_modules directory (a directory, which `FileSystem` does not see). */
    private readonly installed: () => Promise<boolean>,
  ) {}

  async execute(): Promise<Result<Readiness, MetatorError>> {
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
    checks.push(await this.dependencies());
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
    return ok({ ready: checks.every((c) => c.status !== "fail"), checks });
  }

  /** A Node project without node_modules: its tests, type checker and linters cannot run in a run. */
  private async dependencies(): Promise<ReadinessCheck> {
    if (!(await this.fs.exists("package.json")))
      return { id: "dependencies", status: "ok", message: "not a Node project: nothing to install" };
    if (await this.installed())
      return { id: "dependencies", status: "ok", message: "dependencies are installed" };
    let fix = "npm install";
    for (const [lock, command] of INSTALL)
      if (await this.fs.exists(lock)) {
        fix = command;
        break;
      }
    return {
      id: "dependencies",
      status: "warn",
      message:
        "dependencies are not installed: in a run, tests, the type checker and linters cannot run, so gates check only rules",
      fix,
    };
  }
}

/** What a run feels of readiness: its tests and gates, its push. Config and canon are `metator doctor`'s. */
export const RUN_READINESS: readonly ReadinessCheck["id"][] = ["gates", "dependencies", "remote"];

/** One warning per check that is not ok (only the `only` checks, when given). */
export const readinessWarnings = (r: Readiness, only?: readonly ReadinessCheck["id"][]): string[] =>
  r.checks
    .filter((c) => c.status !== "ok" && (!only || only.includes(c.id)))
    .map((c) => `${c.id}: ${c.message}${c.fix ? ` (fix: ${c.fix})` : ""}`);
