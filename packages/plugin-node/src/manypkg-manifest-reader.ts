import { join } from "node:path";
import {
  err,
  type ManifestReader,
  type ManifestSet,
  type MetatorError,
  manifestOf,
  ok,
  type Result,
  type WorkspaceReader,
} from "@metator/core";

const readJson = async (file: string): Promise<Record<string, unknown> | undefined> => {
  const f = Bun.file(file);
  if (!(await f.exists())) return undefined;
  try {
    const json = (await f.json()) as unknown;
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // a broken project.json or turbo.json carries no tags
  }
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Manifests of the workspace packages (the ones `WorkspaceReader` lists, so every manager
 * @manypkg knows) and of the repository root. Tags come from Nx (`project.json#tags`,
 * `package.json#nx.tags`) and Turborepo (`turbo.json#tags`); the project type from Nx.
 */
export class ManypkgManifestReader implements ManifestReader {
  constructor(
    private readonly root: string,
    private readonly workspace: WorkspaceReader,
  ) {}

  async manifests(): Promise<Result<ManifestSet, MetatorError>> {
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const rootJson = await readJson(join(this.root, "package.json"));
    const manifests = [];
    for (const pkg of packages.value) {
      const dir = join(this.root, pkg.dir);
      const json = (await readJson(join(dir, "package.json"))) ?? { name: pkg.name };
      const project = await readJson(join(dir, "project.json"));
      const turbo = await readJson(join(dir, "turbo.json"));
      const nx = json.nx && typeof json.nx === "object" ? (json.nx as Record<string, unknown>) : {};
      const type = project?.projectType ?? nx.projectType;
      manifests.push(
        manifestOf(pkg.dir, json, {
          tags: [...strings(project?.tags), ...strings(nx.tags), ...strings(turbo?.tags)],
          ...(type === "application" || type === "library" ? { projectType: type } : {}),
        }),
      );
    }
    return ok({ ...(rootJson ? { root: manifestOf(".", rootJson) } : {}), packages: manifests });
  }
}
