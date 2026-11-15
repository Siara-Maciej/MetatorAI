import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  artifactKind,
  artifactNameProblem,
  capText,
  RUN_ARTIFACT_MAX_BYTES,
  type RunArtifact,
  type RunArtifactText,
} from "../domain/run-artifacts.ts";
import { isRunBookkeeping } from "../domain/run-record.ts";
import type { FileStats, ReadonlyFileSystem } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";
import type { WorkflowCatalog } from "./workflow-catalog.ts";

export interface RunArtifactsDependencies {
  readonly fs: ReadonlyFileSystem;
  readonly stats: FileStats;
  readonly repo: Pick<RunRepository, "resolveId" | "load" | "runDir">;
  readonly catalog: Pick<WorkflowCatalog, "get">;
}

const SHOWN = ["md", "json", "yml", "yaml", "txt", "log"];

/**
 * The files of a run a person reads in the app (`GET /runs/:run/artifacts[/:name]`): every text
 * file of the run directory of a kind the app shows, and the artifacts the workflow's stages
 * produce that are not written yet. A name is read only when it is inside the run directory,
 * also after following a link, and at most `RUN_ARTIFACT_MAX_BYTES` of it.
 */
export class RunArtifacts {
  constructor(private readonly d: RunArtifactsDependencies) {}

  async list(runId: string | undefined): Promise<Result<readonly RunArtifact[], MetatorError>> {
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const dir = this.d.repo.runDir(id.value);
    const spec = await this.d.catalog.get(record.value.workflow.id);
    const declared = new Map<string, string>();
    if (spec.isOk())
      for (const s of spec.value.spec.stages) for (const a of s.produces ?? []) declared.set(a, s.id);
    const out: RunArtifact[] = [];
    const files = await this.d.fs.glob([`${dir}/**/*.{${SHOWN.join(",")}}`]);
    for (const file of [...files].sort()) {
      const name = file.slice(dir.length + 1);
      const kind = artifactKind(name);
      if (!kind || artifactNameProblem(name)) continue;
      const stat = await this.inside(dir, file);
      if (!stat) continue;
      const stage = declared.get(name);
      out.push({
        name,
        kind,
        size: stat.size,
        updatedAt: stat.modifiedAt,
        expected: false,
        ...(stage ? { stage } : {}),
        bookkeeping: isRunBookkeeping(name),
      });
    }
    const written = new Set(out.map((a) => a.name));
    for (const [name, stage] of declared) {
      const kind = artifactKind(name);
      if (!kind || written.has(name)) continue;
      out.push({ name, kind, size: 0, updatedAt: null, expected: true, stage, bookkeeping: false });
    }
    return ok(out);
  }

  async read(runId: string | undefined, name: string): Promise<Result<RunArtifactText, MetatorError>> {
    const refused = artifactNameProblem(name);
    if (refused) return err(MetatorError.usage(`${name} cannot be read as an artifact: ${refused}`));
    const id = await this.d.repo.resolveId(runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const dir = this.d.repo.runDir(id.value);
    const file = `${dir}/${name}`;
    const stat = await this.inside(dir, file);
    if (stat === undefined) return err(MetatorError.notFound(`artifact ${name} of run ${id.value}`));
    if (stat === null)
      return err(MetatorError.usage(`${name} leads out of the run directory: it is not read as an artifact`));
    const text = await this.d.fs.read(file);
    if (text.isErr()) return err(text.error);
    const capped = capText(text.value, RUN_ARTIFACT_MAX_BYTES);
    return ok({ name, kind: artifactKind(name) ?? "text", text: capped.text, truncated: capped.truncated });
  }

  /**
   * The file's size and time when it is a file of the run directory (a link counts by where it
   * leads); null when it leads out of it; undefined when there is no such file.
   */
  private async inside(dir: string, file: string) {
    const stat = await this.d.stats.stat(file);
    if (!stat || stat.directory) return undefined;
    // The run directory itself may be a link (a worktree's runs are its checkout's): compare real paths.
    const home = await this.d.stats.stat(dir);
    if (!home?.directory || !stat.real.startsWith(`${home.real.replace(/\/+$/, "")}/`)) return null;
    return stat;
  }
}
