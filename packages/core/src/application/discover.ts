import {
  AI_SIGNATURES,
  CI_SIGNATURES,
  classifyScript,
  codeHostOf,
  type Discovery,
  DiscoveryDocument,
  TOOL_SIGNATURES,
} from "../domain/discovery.ts";
import type { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem, PackageManagerDetector, Vcs, WorkspaceReader } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

const ADR_DIRS = ["docs/adr", "docs/decisions", "doc/adr", "doc/architecture/decisions", "adr"];
const CODEOWNERS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const MAX_FILES_PER_HOST = 50;

interface Manifest {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/**
 * Discovery step B1 + B2 (ARCHITECTURE §10): deterministic facts with evidence, written to
 * `paths.discovery` for `metator init` and the bootstrap agent. Nothing here guesses.
 */
export class Discover {
  constructor(
    private readonly fs: FileSystem,
    private readonly sources: SourceFiles,
    private readonly vcs: Vcs,
    private readonly workspace: WorkspaceReader,
    private readonly packageManager: PackageManagerDetector,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(): Promise<Result<Discovery, MetatorError>> {
    const files = await this.sources.list();
    if (files.isErr()) return err(files.error);
    const pm = await this.packageManager.detect();
    if (pm.isErr()) return err(pm.error);
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const warnings: string[] = [];
    if ((pm.value?.lockfiles.length ?? 0) > 1) {
      warnings.push(
        `several lockfiles (${pm.value?.lockfiles.join(", ")}): keep the one of ${pm.value?.name}`,
      );
    }

    // The root package is a package too (manypkg lists only workspace members in a monorepo).
    const dirs = [
      ...new Map([{ name: "(root)", dir: "." }, ...packages.value].map((p) => [p.dir, p])).values(),
    ];
    const scripts: Discovery["scripts"][number][] = [];
    const manifests: { dir: string; manifest: Manifest }[] = [];
    for (const { name, dir } of dirs) {
      const file = dir === "." ? "package.json" : `${dir}/package.json`;
      const manifest = await this.manifest(file);
      if (!manifest) continue;
      manifests.push({ dir, manifest });
      for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
        scripts.push({
          package: manifest.name ?? name,
          dir,
          name: script,
          command,
          candidates: classifyScript(script, command, `${file}#scripts.${script}`).map((c) => ({
            ...c,
            evidence: [...c.evidence],
          })),
        });
      }
    }

    const tools: Discovery["tools"][number][] = [];
    for (const t of TOOL_SIGNATURES) {
      const evidence = t.files.filter((f) => files.value.includes(f));
      for (const { dir, manifest } of manifests) {
        for (const pkg of t.packages) {
          for (const field of ["devDependencies", "dependencies"] as const) {
            if (manifest[field]?.[pkg])
              evidence.push(`${dir === "." ? "" : `${dir}/`}package.json#${field}.${pkg}`);
          }
        }
      }
      if (evidence.length > 0) tools.push({ id: t.id, evidence });
    }

    const remote = await this.vcs.remoteUrl();
    const discovery: Discovery = {
      packageManager: pm.value ? { ...pm.value, lockfiles: [...pm.value.lockfiles] } : null,
      workspaces: packages.value.map((p) => ({ name: p.name, dir: p.dir })),
      scripts,
      tools,
      ci: CI_SIGNATURES.map((c) => ({
        kind: c.kind,
        files: files.value.filter((f) => matchesAny(f, c.globs)),
      })).filter((c) => c.files.length > 0),
      codeHost:
        remote.isOk() && remote.value ? { kind: codeHostOf(remote.value), remote: remote.value } : null,
      docs: {
        adr:
          ADR_DIRS.find((d) => files.value.some((f) => f.startsWith(`${d}/`) && f.endsWith(".md"))) ?? null,
        codeowners: CODEOWNERS.find((f) => files.value.includes(f)) ?? null,
      },
      ai: AI_SIGNATURES.map((a) => ({
        host: a.host,
        files: files.value.filter((f) => matchesAny(f, a.globs)).slice(0, MAX_FILES_PER_HOST),
      })).filter((a) => a.files.length > 0),
      warnings,
    };
    const saved = await this.fs.write(
      this.paths.discovery,
      serializeJsonDocument(DiscoveryDocument.stamp(discovery)),
    );
    if (saved.isErr()) return err(saved.error);
    return ok(discovery);
  }

  /** package.json is the package manager's format, read as-is (not a MetatorAI document). */
  private async manifest(file: string): Promise<Manifest | undefined> {
    const text = await this.fs.read(file);
    if (text.isErr()) return undefined;
    try {
      return JSON.parse(text.value) as Manifest;
    } catch {
      return undefined;
    }
  }
}
