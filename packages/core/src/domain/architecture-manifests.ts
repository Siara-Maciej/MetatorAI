/** What the package manifests of a repository declare: the facts the architecture analysis starts from. */

/** Files outside every workspace package belong to the repository root. */
export const ROOT_PACKAGE = "(root)";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** What `package.json` (and Nx `project.json`, Turborepo `turbo.json`) say about one package. */
export interface PackageManifest {
  readonly name: string;
  /** Repo-relative directory; "." for the repository root. */
  readonly dir: string;
  readonly private: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  /** `main`, `module`, `exports` or `types`: something other packages load. */
  readonly entry: boolean;
  /** Repo-relative files those fields point to (their public API). */
  readonly entries: readonly string[];
  readonly bin: boolean;
  readonly scripts: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly projectType?: "application" | "library";
}

export interface ManifestSet {
  readonly root?: PackageManifest;
  readonly packages: readonly PackageManifest[];
}

const record = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      )
    : {};

/** A manifest from a parsed `package.json`; anything malformed reads as absent. */
export function manifestOf(
  dir: string,
  json: unknown,
  extra: { readonly tags?: readonly string[]; readonly projectType?: "application" | "library" } = {},
): PackageManifest {
  const pkg = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const has = (key: string) => pkg[key] !== undefined && pkg[key] !== null;
  return {
    name: typeof pkg.name === "string" && pkg.name !== "" ? pkg.name : dir === "." ? ROOT_PACKAGE : dir,
    dir,
    private: pkg.private === true,
    dependencies: record(pkg.dependencies),
    peerDependencies: record(pkg.peerDependencies),
    optionalDependencies: record(pkg.optionalDependencies),
    devDependencies: record(pkg.devDependencies),
    entry: has("main") || has("module") || has("exports") || has("types"),
    entries: entryFiles(dir, [pkg.main, pkg.module, pkg.types, pkg.exports]),
    bin: has("bin"),
    scripts: record(pkg.scripts),
    tags: [...new Set(extra.tags ?? [])].sort(),
    ...(extra.projectType ? { projectType: extra.projectType } : {}),
  };
}

/** Every string leaf of the entry fields, as repo-relative paths. */
function entryFiles(dir: string, values: readonly unknown[]): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const rel = v.replace(/^\.\//, "");
      if (!rel.startsWith("..") && !rel.includes("*")) out.add(dir === "." ? rel : `${dir}/${rel}`);
    } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  for (const v of values) walk(v);
  return [...out].sort();
}

/** The field that declares `dependency`, preferring the ones that ship. */
export function declaredIn(
  manifest: PackageManifest | undefined,
  dependency: string,
): DependencyField | undefined {
  return manifest ? DEPENDENCY_FIELDS.find((f) => manifest[f][dependency] !== undefined) : undefined;
}
