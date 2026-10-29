import { type ApiDiff, type ApiSnapshot, ApiSnapshotDocument, apiSurface, diffApi } from "../domain/api.ts";
import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { DeclarationEmitter, FileSystem, WorkspaceReader } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

interface Manifest {
  readonly exports?: unknown;
  readonly main?: string;
  readonly module?: string;
}

/** The source file a package's `.` export (or main) points at, e.g. `src/index.ts`. */
function entryOf(manifest: Manifest): string | undefined {
  let target: unknown = manifest.exports;
  if (typeof target === "object" && target !== null && "." in target)
    target = (target as Record<string, unknown>)["."];
  while (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    target = t.import ?? t.default ?? t.module ?? t.require ?? t.types;
  }
  const path = typeof target === "string" ? target : (manifest.module ?? manifest.main);
  return path?.replace(/^\.\//, "");
}

/** The targets of a package's subpath pattern exports (`"./*": "./src/*.ts"`), without `./`. */
function wildcardExports(manifest: Manifest): string[] {
  const exports = manifest.exports;
  if (typeof exports !== "object" || exports === null) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(exports as Record<string, unknown>)) {
    let target = value;
    while (typeof target === "object" && target !== null) {
      const t = target as Record<string, unknown>;
      target = t.import ?? t.default ?? t.module ?? t.require ?? t.types;
    }
    if (key.includes("*") && typeof target === "string" && target.includes("*"))
      out.push(target.replace(/^\.\//, ""));
  }
  return out;
}

/** `api snapshot|diff <package>` (ADR-0040): the package's declarations now versus a snapshot. */
export class ApiSnapshots {
  constructor(
    private readonly emitter: DeclarationEmitter,
    private readonly workspace: WorkspaceReader,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  snapshotFile(pkg: string): string {
    return `${this.paths.api}/${pkg.replace(/^@/, "").replaceAll("/", "__")}.json`;
  }

  async current(pkg: string): Promise<Result<ApiSnapshot, MetatorError>> {
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const found = packages.value.find((p) => p.name === pkg);
    if (!found)
      return err(MetatorError.notFound(`package ${pkg}`, { known: packages.value.map((p) => p.name) }));
    const manifestFile = found.dir === "." ? "package.json" : `${found.dir}/package.json`;
    const text = await this.fs.read(manifestFile);
    if (text.isErr()) return err(text.error);
    const manifest = parseJsonDocument(text.value, manifestFile);
    if (manifest.isErr()) return err(manifest.error);
    const prefix = found.dir === "." ? "" : `${found.dir}/`;
    const toDeclaration = (source: string) => `${prefix}${source}`.replace(/\.(m|c)?(t|j)sx?$/, ".d.ts");
    const source = entryOf(manifest.value as Manifest);
    const patterns = source ? [] : wildcardExports(manifest.value as Manifest);
    if (!source && patterns.length === 0)
      return err(new MetatorError("INVALID_CONFIG", `${manifestFile} names no entry (exports "." or main)`));
    const declarations = await this.emitter.emit();
    if (declarations.isErr()) return err(declarations.error);
    if (!source) {
      // Subpath patterns (`"./*": "./src/**/*.ts"`): every module they expose is the API.
      const globs = patterns.map(toDeclaration);
      const starts = [...declarations.value.keys()].filter((f) => matchesAny(f, globs)).sort();
      if (starts.length === 0)
        return err(
          new MetatorError("NOT_FOUND", `no declarations for ${globs.join(", ")}`, {
            hint: "The exported files must be part of the TypeScript project.",
          }),
        );
      return ok(apiSurface(pkg, globs.join(" "), declarations.value, starts));
    }
    const entry = toDeclaration(source);
    if (!declarations.value.has(entry))
      return err(
        new MetatorError("NOT_FOUND", `no declarations for ${entry}`, {
          hint: "The entry must be part of the TypeScript project.",
        }),
      );
    return ok(apiSurface(pkg, entry, declarations.value));
  }

  async snapshot(input: {
    readonly package: string;
  }): Promise<Result<ApiSnapshot & { readonly output: string }, MetatorError>> {
    const snap = await this.current(input.package);
    if (snap.isErr()) return err(snap.error);
    const output = this.snapshotFile(input.package);
    const saved = await this.fs.write(output, serializeJsonDocument(ApiSnapshotDocument.stamp(snap.value)));
    if (saved.isErr()) return err(saved.error);
    return ok({ ...snap.value, output });
  }

  async diff(input: {
    readonly package: string;
  }): Promise<Result<ApiDiff & { readonly package: string }, MetatorError>> {
    const file = this.snapshotFile(input.package);
    const text = await this.fs.read(file);
    if (text.isErr())
      return err(
        new MetatorError("NOT_FOUND", `no API snapshot for ${input.package}`, {
          hint: `Take one before the change: \`metator api snapshot ${input.package}\`.`,
        }),
      );
    const base = parseJsonDocument(text.value, file).andThen((raw) => ApiSnapshotDocument.parse(raw, file));
    if (base.isErr()) return err(base.error);
    const now = await this.current(input.package);
    if (now.isErr()) return err(now.error);
    return ok({ package: input.package, ...diffApi(base.value, now.value) });
  }
}
