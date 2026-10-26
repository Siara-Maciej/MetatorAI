import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type Application,
  contractUsers,
  deployWaves,
  lintSystemMap,
  type SystemMap,
  SystemMapDocument,
  type SystemProblem,
} from "../domain/system-map.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";

/** Reads the system map (`docs/metator/system.yml` by default); no file means no map. */
export class SystemCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly file: string,
  ) {}

  get source(): string {
    return this.file;
  }

  async load(): Promise<Result<SystemMap | undefined, MetatorError>> {
    const text = await this.fs.read(this.file);
    if (text.isErr()) return ok(undefined);
    return parseYamlDocument(text.value, this.file).andThen((raw) => SystemMapDocument.parse(raw, this.file));
  }
}

const join = (dir: string, path: string) =>
  dir === "." || dir === "" ? path : `${dir.replace(/\/$/, "")}/${path}`;

/** The directory of an application in this repository, or undefined for another repository. */
function localDir(app: Application): string | undefined {
  return "path" in app.source && !("repo" in app.source) ? app.source.path : undefined;
}

export interface SystemLintReport {
  readonly source: string;
  /** False when the repository has no system map: nothing to check. */
  readonly mapped: boolean;
  readonly problems: readonly SystemProblem[];
  /** Specifications in other repositories, checked once their sources are read (F7.3). */
  readonly unchecked: readonly string[];
}

/**
 * `system lint` (ADR-0047): the map's references hold (owners, consumed contracts, contract
 * kinds a plugin provides, no deploy cycle) and what lives in this repository exists.
 */
export class LintSystem {
  constructor(
    private readonly catalog: Pick<SystemCatalog, "load" | "source">,
    private readonly fs: ReadonlyFileSystem,
    private readonly kinds: readonly string[],
  ) {}

  async execute(): Promise<Result<SystemLintReport, MetatorError>> {
    const loaded = await this.catalog.load();
    if (loaded.isErr()) return err(loaded.error);
    const source = this.catalog.source;
    const map = loaded.value;
    if (!map) return ok({ source, mapped: false, problems: [], unchecked: [] });

    const problems = [...lintSystemMap(map, this.kinds)];
    const unchecked: string[] = [];
    const apps = new Map(map.applications.map((a) => [a.id, a]));
    for (const [i, app] of map.applications.entries()) {
      const dir = localDir(app);
      if (dir === undefined || dir === ".") continue;
      if ((await this.fs.glob([`${dir.replace(/\/$/, "")}/**`])).length === 0)
        problems.push({
          severity: "error",
          path: `applications.${i}.source.path`,
          message: `"${app.id}": directory ${dir} does not exist`,
        });
    }
    for (const [i, c] of map.contracts.entries()) {
      const owner = apps.get(c.owner);
      if (!owner) continue; // reported by the map lint
      const dir = localDir(owner);
      if (dir === undefined) {
        unchecked.push(`${c.id}: ${c.spec.path} in ${"repo" in owner.source ? owner.source.repo : owner.id}`);
        continue;
      }
      const spec = join(dir, c.spec.path);
      if (!(await this.fs.exists(spec)))
        problems.push({
          severity: "error",
          path: `contracts.${i}.spec.path`,
          message: `contract "${c.id}": specification ${spec} does not exist`,
        });
    }
    return ok({ source, mapped: true, problems, unchecked });
  }
}

/** `system show`: the map with what follows from it (consumers per contract, deploy waves). */
export class ShowSystem {
  constructor(private readonly catalog: Pick<SystemCatalog, "load" | "source">) {}

  async execute(): Promise<
    Result<
      {
        readonly source: string;
        readonly system: string;
        readonly applications: readonly Application[];
        readonly contracts: ReturnType<typeof contractUsers>;
        readonly deployWaves?: readonly (readonly string[])[];
      },
      MetatorError
    >
  > {
    const loaded = await this.catalog.load();
    if (loaded.isErr()) return err(loaded.error);
    const map = loaded.value;
    if (!map)
      return err(
        new MetatorError("NOT_FOUND", `No system map at ${this.catalog.source}`, {
          hint: "Describe the applications and their contracts there; `metator system schema` prints the format.",
        }),
      );
    const waves = map.policies.deployOrder === "providers-first" ? deployWaves(map) : undefined;
    return ok({
      source: this.catalog.source,
      system: map.system,
      applications: map.applications,
      contracts: contractUsers(map),
      ...(waves ? { deployWaves: waves } : {}),
    });
  }
}
