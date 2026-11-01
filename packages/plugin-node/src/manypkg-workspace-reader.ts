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
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

/** Config files of an application framework: one at the root means the root is an application. */
const ROOT_APP_CONFIGS = [
  ...["next", "nuxt", "astro", "svelte", "remix", "vite"].flatMap((f) =>
    ["js", "mjs", "cjs", "ts", "mts"].map((ext) => `${f}.config.${ext}`),
  ),
  "angular.json",
  "nest-cli.json",
];

/** Directories whose package.json is a fixture, an example or tooling, not a package of the repo. */
const NOT_PACKAGES =
  /^(\..*|node_modules|dist|build|out|coverage|tests?|__tests__|e2e|fixtures?|__fixtures__|examples?|docs?|scripts|playwright|cypress)$/;

/**
 * Workspace packages via @manypkg/get-packages: npm, yarn, pnpm, bun, lerna and rush workspaces.
 * A single-package repository yields its root package (dir "."); a repo without package.json none.
 */
export class ManypkgWorkspaceReader implements WorkspaceReader {
  constructor(private readonly root: string) {}

  async packages(): Promise<Result<readonly WorkspacePackage[], MetatorError>> {
    if (!existsSync(join(this.root, "package.json"))) return ok([]);
    const invalid = (e: unknown) =>
      err(
        new MetatorError("INVALID_CONFIG", `Cannot read workspace packages: ${(e as Error).message}`, {
          hint: "Check package.json#workspaces (or pnpm-workspace.yaml) for invalid globs or package files.",
        }),
      );
    let found: WorkspacePackage[] = [];
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
      if (!/missing the "name" field/.test((e as Error).message)) return invalid(e);
    }
    try {
      const manifest = (await Bun.file(join(this.root, "package.json")).json()) as Manifest;
      rootName ??= manifest.name;
      const onlyRoot = found.length === 0 || (found.length === 1 && found[0]?.dir === ".");
      let rootRuns = false;
      if (onlyRoot) {
        const declared = await this.declaredWorkspaces();
        const nested = declared.length > 0 ? [] : await this.nestedPackages();
        if (declared.length > 0) found = declared;
        else if (nested.length >= 2) {
          // Services side by side without a workspace (`user/`, `mailer/`, `gateway/`, each with its
          // own package.json and lockfile): each is a package; the root only when it runs code too.
          found = nested;
          rootRuns = Object.keys(manifest.dependencies ?? {}).length > 0;
        }
      }
      const root = { name: rootName ?? (basename(this.root) || "(root)"), dir: "." };
      // An application at the root next to its workspaces (a Nuxt app with a `proxy` package) is a
      // package too; a monorepo root that only holds tooling is not.
      if (found.length === 0 || (!found.some((p) => p.dir === ".") && (rootRuns || this.appAtRoot())))
        found.push(root);
      return ok(found.sort((a, b) => a.dir.localeCompare(b.dir)));
    } catch (e) {
      return invalid(e);
    }
  }

  /** package.json files one or two directories down, outside tests, examples and tooling. */
  private async nestedPackages(): Promise<WorkspacePackage[]> {
    const found: WorkspacePackage[] = [];
    for (const pattern of ["*/package.json", "*/*/package.json"])
      for await (const file of new Bun.Glob(pattern).scan({ cwd: this.root })) {
        const dir = normalizePath(file).slice(0, -"/package.json".length);
        if (dir.split("/").some((d) => NOT_PACKAGES.test(d))) continue;
        const pkg = (await Bun.file(join(this.root, file)).json()) as Manifest;
        found.push({ name: pkg.name ?? dir, dir, standalone: true });
      }
    return found;
  }

  private appAtRoot(): boolean {
    return ROOT_APP_CONFIGS.some((f) => existsSync(join(this.root, f)));
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
