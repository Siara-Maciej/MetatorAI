import { MetatorError } from "../domain/errors.ts";
import {
  contentHash,
  holdsCanon,
  type InstallLock,
  InstallLockDocument,
  type InstallStep,
  planInstall,
  writesFile,
} from "../domain/install.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem, ReadonlyFileSystem } from "../ports/index.ts";
import { DEFAULT_PATHS, type MetatorPaths } from "./paths.ts";

export interface InstallInput {
  /** install: first time (fails when a lock exists); update: from a lock (fails without one). */
  readonly mode: "install" | "update";
  /** Workflow ids; omitted means every workflow (install) or the ones in the lock (update). */
  readonly workflows?: readonly string[];
  /** Resolve conflicts with the canon's version instead of keeping the local one. */
  readonly theirs: boolean;
  readonly dryRun: boolean;
}

export interface InstallReport {
  readonly version: string;
  readonly from: string;
  /** Every workflow the canon ships. */
  readonly available: readonly string[];
  readonly workflows: readonly string[];
  readonly steps: readonly InstallStep[];
  readonly removedUpstream: readonly string[];
  /** The lock file written, or null for a dry run. */
  readonly lock: string | null;
}

/** Where the canon of the running MetatorAI lives; null when the installation has none. */
export interface CanonSource {
  readonly files: ReadonlyFileSystem;
  readonly location: string;
  readonly version: string;
}

const workflowId = (file: string) => (file.split("/").pop() as string).replace(/\.ya?ml$/, "");

/**
 * `agents install|update`: copy the agents, skills and workflows shipped with MetatorAI into
 * the repository, at its configured paths. A file someone edited is never replaced silently.
 */
export class InstallCanon {
  constructor(
    private readonly source: CanonSource | null,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(input: InstallInput): Promise<Result<InstallReport, MetatorError>> {
    const source = this.source;
    if (!source) {
      return err(
        new MetatorError("NOT_FOUND", "this MetatorAI installation ships no agent canon", {
          hint: "Point METATOR_CANON at a MetatorAI checkout (the directory with metator/agents).",
        }),
      );
    }
    const lock = await this.readLock();
    if (lock.isErr()) return err(lock.error);
    if (input.mode === "install" && lock.value) {
      return err(
        MetatorError.usage(
          `the canon is already installed (${this.paths.installLock})`,
          "Run `metator agents update` to take a newer canon.",
        ),
      );
    }
    if (input.mode === "update" && !lock.value) {
      return err(
        MetatorError.usage(
          `no ${this.paths.installLock}: the canon was not installed by MetatorAI`,
          "Run `metator agents install` first (it keeps files you already have).",
        ),
      );
    }

    const shipped = (await source.files.glob([`${DEFAULT_PATHS.workflows}/*.{yml,yaml}`])).toSorted();
    const available = shipped.map(workflowId);
    const chosen = input.workflows ?? lock.value?.workflows ?? available;
    const unknown = chosen.filter((w) => !available.includes(w));
    if (unknown.length > 0) {
      return err(
        MetatorError.usage(
          `unknown workflow(s): ${unknown.join(", ")}`,
          `Shipped workflows: ${available.join(", ")}.`,
        ),
      );
    }

    // Shipped path → repository path, under the repository's configured locations.
    const mapping = new Map<string, string>();
    for (const [from, to] of [
      [DEFAULT_PATHS.agents, this.paths.agents],
      [DEFAULT_PATHS.skills, this.paths.skills],
    ] as const) {
      for (const file of await source.files.glob([`${from}/**`]))
        mapping.set(file, `${to}${file.slice(from.length)}`);
    }
    for (const file of shipped)
      if (chosen.includes(workflowId(file)))
        mapping.set(file, `${this.paths.workflows}${file.slice(DEFAULT_PATHS.workflows.length)}`);

    const content = new Map<string, string>();
    const canon = new Map<string, string>();
    const current = new Map<string, string>();
    for (const [from, to] of mapping) {
      const text = await source.files.read(from);
      if (text.isErr()) return err(text.error);
      content.set(to, text.value);
      canon.set(to, await contentHash(text.value));
      if (await this.fs.exists(to)) {
        const have = await this.fs.read(to);
        if (have.isErr()) return err(have.error);
        current.set(to, await contentHash(have.value));
      }
    }

    const plan = planInstall({ canon, current, lock: lock.value, theirs: input.theirs });
    const files: Record<string, string> = {};
    for (const step of plan.steps) {
      const kept = lock.value?.files[step.path];
      if (holdsCanon(step.action)) files[step.path] = canon.get(step.path) as string;
      else if (kept) files[step.path] = kept;
    }
    const report = {
      version: source.version,
      from: source.location,
      available,
      workflows: [...chosen].sort(),
      steps: plan.steps,
      removedUpstream: plan.removedUpstream,
    };
    if (input.dryRun) return ok({ ...report, lock: null });

    for (const step of plan.steps) {
      if (!writesFile(step.action)) continue;
      const saved = await this.fs.write(step.path, content.get(step.path) as string);
      if (saved.isErr()) return err(saved.error);
    }
    const next: InstallLock = { version: source.version, workflows: report.workflows, files };
    const saved = await this.fs.write(
      this.paths.installLock,
      serializeJsonDocument(InstallLockDocument.stamp(next)),
    );
    if (saved.isErr()) return err(saved.error);
    return ok({ ...report, lock: this.paths.installLock });
  }

  private async readLock(): Promise<Result<InstallLock | undefined, MetatorError>> {
    const file = this.paths.installLock;
    if (!(await this.fs.exists(file))) return ok(undefined);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file).andThen((raw) => InstallLockDocument.parse(raw, file));
  }
}
