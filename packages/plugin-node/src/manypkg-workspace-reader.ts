import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { getPackages } from "@manypkg/get-packages";
import {
  err,
  MetatorError,
  normalizePath,
  ok,
  type Result,
  type WorkspacePackage,
  type WorkspaceReader,
} from "@metator/core";

interface Manifest {
  readonly name?: string;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

/**
 * Workspace packages via @manypkg/get-packages: npm, yarn, pnpm, bun, lerna and rush workspaces.
 * A single-package repository yields its root package (dir "."); a repo without package.json none.
 */
export class ManypkgWorkspaceReader implements WorkspaceReader {
  constructor(private readonly root: string) {}

  async packages(): Promise<Result<readonly WorkspacePackage[], MetatorError>> {
    if (!existsSync(join(this.root, "package.json"))) return ok([]);
    try {
      let found: WorkspacePackage[];
      let rootName: string | undefined;
      try {
        const { packages, rootPackage } = await getPackages(this.root);
        rootName = rootPackage?.packageJson.name;
        found = packages.map((p) => ({
          name: p.packageJson.name,
          dir: normalizePath(relative(this.root, p.dir)) || ".",
        }));
      } catch (e) {
        // manypkg refuses a repository where any package.json has no name (an app that is never
        // published, a proxy folder): such a package is named after its directory instead.
        if (!/missing the "name" field/.test((e as Error).message)) throw e;
        found = [];
        rootName = ((await Bun.file(join(this.root, "package.json")).json()) as Manifest).name;
      }
      const onlyRoot = found.length === 0 || (found.length === 1 && found[0]?.dir === ".");
      if (onlyRoot) {
        const declared = await this.declaredWorkspaces();
        if (declared.length > 0) found = declared;
      }
      if (found.length === 0) found.push({ name: rootName ?? (basename(this.root) || "(root)"), dir: "." });
      return ok(found.sort((a, b) => a.dir.localeCompare(b.dir)));
    } catch (e) {
      return err(
        new MetatorError("INVALID_CONFIG", `Cannot read workspace packages: ${(e as Error).message}`, {
          hint: "Check package.json#workspaces (or pnpm-workspace.yaml) for invalid globs or package files.",
        }),
      );
    }
  }

  /**
   * manypkg detects the tool from the lockfile; a repo with `workspaces` but no lockfile yet
   * (fresh clone, ignored lockfile) would look like a single package. Expand the globs instead,
   * from package.json#workspaces or pnpm-workspace.yaml; a `!` pattern excludes, so it is skipped.
   */
  private async declaredWorkspaces(): Promise<WorkspacePackage[]> {
    const manifest = (await Bun.file(join(this.root, "package.json")).json()) as Manifest;
    const pnpm = Bun.file(join(this.root, "pnpm-workspace.yaml"));
    const pnpmPatterns = (await pnpm.exists())
      ? (((Bun.YAML.parse(await pnpm.text()) as { packages?: readonly string[] } | null)?.packages ??
          []) as readonly string[])
      : [];
    const patterns = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : ((manifest.workspaces as { packages?: readonly string[] } | undefined)?.packages ?? pnpmPatterns);
    const found: WorkspacePackage[] = [];
    for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
      const glob = new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`);
      for await (const file of glob.scan({ cwd: this.root })) {
        if (file.includes("node_modules/")) continue;
        const pkg = (await Bun.file(join(this.root, file)).json()) as Manifest;
        const dir = normalizePath(file).slice(0, -"/package.json".length);
        found.push({ name: pkg.name ?? dir, dir });
      }
    }
    return found;
  }
}
