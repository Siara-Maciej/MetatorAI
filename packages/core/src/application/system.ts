import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type Application,
  appDir,
  contractUsers,
  deployWaves,
  lintSystemMap,
  type SystemMap,
  SystemMapDocument,
  type SystemProblem,
  specPath,
} from "../domain/system-map.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { CheckoutReader, ReadonlyFileSystem } from "../ports/index.ts";
import type { SystemLocation, SystemSources } from "./system-sources.ts";

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
    if (!(await this.fs.exists(this.file))) return ok(undefined);
    const text = await this.fs.read(this.file);
    if (text.isErr()) return err(text.error);
    return parseYamlDocument(text.value, this.file).andThen((raw) => SystemMapDocument.parse(raw, this.file));
  }
}

export interface SystemLintReport {
  readonly source: string;
  /** False when the repository has no system map: nothing to check. */
  readonly mapped: boolean;
  readonly problems: readonly SystemProblem[];
  /** Specifications in other repositories that have no checkout here (`--fetch` clones them). */
  readonly unchecked: readonly string[];
}

/**
 * `system lint` (ADR-0047): the map's references hold (owners, consumed contracts, contract
 * kinds a plugin provides, no deploy cycle), this repository's application directories exist,
 * and every specification exists where its provider's code is: here, a checkout, or a clone.
 */
export class LintSystem {
  constructor(
    private readonly sources: Pick<SystemSources, "locate" | "location">,
    private readonly fs: ReadonlyFileSystem,
    private readonly kinds: readonly string[],
    private readonly reader: Pick<CheckoutReader, "read">,
  ) {}

  async execute(options: { readonly fetch?: boolean } = {}): Promise<Result<SystemLintReport, MetatorError>> {
    const { location } = this.sources;
    const loaded = await location.load();
    if (loaded.isErr()) return err(loaded.error);
    const source = location.source;
    const map = loaded.value;
    if (!map) return ok({ source, mapped: false, problems: [], unchecked: [] });

    const problems = [...lintSystemMap(map, this.kinds)];
    const unchecked: string[] = [];
    // A map from another repository: its path applications are in that repository's checkout.
    if (location.local)
      for (const [i, app] of map.applications.entries()) {
        const dir = appDir(app);
        if ("repo" in app.source || dir === ".") continue;
        if ((await this.fs.glob([`${dir}/**`])).length === 0)
          problems.push({
            severity: "error",
            path: `applications.${i}.source.path`,
            message: `"${app.id}": directory ${dir} does not exist`,
          });
      }
    const apps = new Map(map.applications.map((a) => [a.id, a]));
    for (const [i, c] of map.contracts.entries()) {
      const owner = apps.get(c.owner);
      if (!owner) continue; // reported by the map lint
      const spec = specPath(owner, c);
      const located = await this.sources.locate(owner, options.fetch ? { fetch: true } : {});
      if (located.isErr()) return err(located.error);
      const where = "repo" in owner.source ? owner.source.repo : owner.id;
      if (!located.value) {
        unchecked.push(`${c.id}: ${spec} in ${where}`);
        continue;
      }
      const text = await this.reader.read(located.value.root, spec);
      if (text.isErr()) return err(text.error);
      if (text.value === undefined)
        problems.push({
          severity: "error",
          path: `contracts.${i}.spec.path`,
          message:
            located.value.via === "here"
              ? `contract "${c.id}": specification ${spec} does not exist`
              : `contract "${c.id}": specification ${spec} does not exist in ${where} (${located.value.via})`,
        });
    }
    return ok({ source, mapped: true, problems, unchecked });
  }
}

/** `system show`: the map with what follows from it (consumers per contract, deploy waves). */
export class ShowSystem {
  constructor(private readonly location: Pick<SystemLocation, "require" | "source">) {}

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
    const loaded = await this.location.require();
    if (loaded.isErr()) return err(loaded.error);
    const map = loaded.value;
    const waves = map.policies.deployOrder === "providers-first" ? deployWaves(map) : undefined;
    return ok({
      source: this.location.source,
      system: map.system,
      applications: map.applications,
      contracts: contractUsers(map),
      ...(waves ? { deployWaves: waves } : {}),
    });
  }
}
