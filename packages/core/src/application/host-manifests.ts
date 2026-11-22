import { MetatorError } from "../domain/errors.ts";
import {
  BUILTIN_MANIFESTS,
  genericManifest,
  type HostManifest,
  HostManifestDocument,
  HostManifestSchema,
} from "../domain/host-manifest.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";
import { loadDocument } from "./document-io.ts";

/** Where a repository overrides a host's manifest: `metator/hosts/<host>.yml`. */
export const HOSTS_DIR = "metator/hosts";

/**
 * The manifests of the hosts (R3): the repository's file for a host when it has one, else the
 * one MetatorAI ships, else a generic one that reads only quiet and exit. Read once per host.
 */
export class HostManifestCatalog {
  private readonly cache = new Map<string, HostManifest>();

  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly dir: string = HOSTS_DIR,
  ) {}

  async get(host: string): Promise<Result<HostManifest, MetatorError>> {
    const cached = this.cache.get(host);
    if (cached) return ok(cached);
    const file = `${this.dir}/${host}.yml`;
    let manifest: HostManifest;
    if (await this.fs.exists(file)) {
      const parsed = await loadDocument(this.fs, file, HostManifestDocument, "yaml");
      if (parsed.isErr()) return err(parsed.error);
      if (parsed.value.host !== host)
        return err(
          MetatorError.usage(
            `${file} describes host ${parsed.value.host}, not ${host}`,
            "Name the file after its host.",
          ),
        );
      manifest = parsed.value;
    } else {
      const builtin = BUILTIN_MANIFESTS.find((m) => m.host === host);
      manifest = builtin ? HostManifestSchema.parse(builtin) : genericManifest(host);
    }
    this.cache.set(host, manifest);
    return ok(manifest);
  }

  /** The hosts MetatorAI ships a manifest for, in order. */
  builtin(): readonly string[] {
    return BUILTIN_MANIFESTS.map((m) => m.host);
  }
}
