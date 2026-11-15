import { MetatorError } from "../domain/errors.ts";
import {
  changeSummary,
  documentDigest,
  documentFromBody,
  editLogOf,
  itemChanges,
  type PlanEdit,
  PlanEditDocument,
  type PlanLintView,
  type SystemDiscoveryView,
  type SystemMapView,
  staleDigest,
} from "../domain/plan-edit.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { lintSystemMap, type SystemMap, SystemMapDocument } from "../domain/system-map.ts";
import { serializeJsonLine } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { writeDocument } from "./document-io.ts";
import type { DiscoverSystem, DiscoverySource } from "./system-discovery.ts";
import type { SystemLocation } from "./system-sources.ts";

export interface SystemMapsDependencies {
  readonly fs: FileSystem;
  readonly location: Pick<SystemLocation, "source" | "local" | "load">;
  /** Contract kinds the installed plugins compare (what the map's lint accepts). */
  readonly kinds: readonly string[];
  /** Where the map's applications' code is on this machine. */
  readonly roots: () => Promise<readonly string[]>;
  readonly discover: Pick<DiscoverSystem, "execute">;
  /** This repository as discovery reads it, and any other repository by its root. */
  readonly here: DiscoverySource;
  readonly sourceAt: (root: string) => DiscoverySource;
  /** The name of this repository's system when it has no folder (its directory's name). */
  readonly system: string;
  readonly clock: Clock;
}

export interface SaveSystemMapInput {
  readonly map: unknown;
  /** The digest of the map the edit is based on; null when there is no map yet. */
  readonly digest: string | null;
  readonly by: string;
  readonly note?: string;
}

const COMMENT = "The system map (metator system): applications, their contracts and consumers.";

/** The map's problems as the app lists them: each names the field it is about. */
export const mapLintView = (map: SystemMap, kinds: readonly string[]): PlanLintView => ({
  problems: lintSystemMap(map, kinds).map((p) => ({
    severity: p.severity,
    message: p.message,
    field: p.path,
  })),
});

/**
 * The system map in the app (`/system/map`, `/system/discover`, ADR-0087): read with its lint,
 * changed by a person when the map is a file of this repository (a pinned map is changed where it
 * lives), proposed from the code of this repository or of every repository of a folder. A write
 * names the digest it was based on and is a line of the map's edit log with who made it.
 */
export class SystemMaps {
  constructor(private readonly d: SystemMapsDependencies) {}

  async view(): Promise<Result<SystemMapView, MetatorError>> {
    const map = await this.d.location.load();
    if (map.isErr()) return err(map.error);
    return ok(await this.viewOf(map.value ?? null));
  }

  async save(input: SaveSystemMapInput): Promise<Result<SystemMapView, MetatorError>> {
    const by = input.by.trim();
    if (by === "") return err(MetatorError.usage("say who changes the map: by"));
    const file = this.d.location.source;
    if (!this.d.location.local)
      return err(
        new MetatorError("TRANSITION_DENIED", `the system map is ${file}, pinned in another repository`, {
          hint: "Change it in the repository that holds it.",
        }),
      );
    const current = await this.d.location.load();
    if (current.isErr()) return err(current.error);
    const before = current.value ?? null;
    const now = before ? documentDigest(before) : null;
    if (input.digest !== now)
      return err(
        new MetatorError("CONFLICT", staleDigest(`the system map ${file}`), {
          hint: "Reload the map; your change is not saved.",
          details: { current: await this.viewOf(before) },
        }),
      );
    const parsed = documentFromBody(SystemMapDocument, input.map, file);
    if (!parsed.ok)
      return err(
        new MetatorError(
          "USAGE",
          `the map does not fit its schema: ${parsed.problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`,
          { hint: "Nothing was saved.", details: { problems: parsed.problems } },
        ),
      );
    const map = parsed.value;
    const changes = before
      ? [
          ...itemChanges("application", before.applications, map.applications),
          ...itemChanges("contract", before.contracts, map.contracts),
        ]
      : [`map written with ${map.applications.length} application(s)`];
    const saved = await writeDocument(this.d.fs, file, SystemMapDocument, map, "yaml", COMMENT);
    if (saved.isErr()) return err(saved.error);
    const logged = await this.log({
      by,
      before: now,
      after: documentDigest(map),
      changes,
      ...(input.note ? { note: input.note } : {}),
    });
    if (logged.isErr()) return err(logged.error);
    return ok(await this.viewOf(map));
  }

  /**
   * A map proposed from the code: of this repository, or of every repository of a folder
   * (`folder`: their roots). With `write`, the proposal becomes the map when there is none (never
   * over one): what is in the map was put there by a person.
   */
  async discover(input: {
    readonly write: boolean;
    readonly by?: string;
    readonly folder?: { readonly root: string; readonly repos: readonly string[] };
  }): Promise<Result<SystemDiscoveryView, MetatorError>> {
    if (input.write && !(input.by ?? "").trim()) return err(MetatorError.usage("say who writes the map: by"));
    if (input.write && !this.d.location.local)
      return err(
        new MetatorError(
          "TRANSITION_DENIED",
          `the system map is ${this.d.location.source}, pinned in another repository`,
        ),
      );
    // What is in the map was put there by a person: a proposal never writes over it.
    const existing = await this.d.location.load();
    if (existing.isErr()) return err(existing.error);
    const write = input.write && existing.value === undefined;
    const sources = input.folder ? input.folder.repos.map((root) => this.d.sourceAt(root)) : [this.d.here];
    const file = this.d.location.source;
    const found = await this.d.discover.execute({
      sources,
      system: input.folder ? basename(input.folder.root) : this.d.system,
      map: { file, load: () => this.d.location.load(), fs: this.d.fs },
      write,
    });
    if (found.isErr()) return err(found.error);
    const written = found.value.written !== undefined;
    if (written) {
      const logged = await this.log({
        by: (input.by ?? "").trim(),
        before: null,
        after: documentDigest(found.value.proposal),
        changes: [
          changeSummary([
            `map proposed from the code with ${found.value.proposal.applications.length} application(s)`,
          ]),
        ],
      });
      if (logged.isErr()) return err(logged.error);
    }
    return ok({
      proposed: found.value.proposal,
      changes: found.value.drift,
      written,
      file,
    });
  }

  private log(entry: Omit<PlanEdit, "at" | "target" | "id">): Promise<Result<void, MetatorError>> {
    const file = this.d.location.source;
    const line: PlanEdit = { at: this.d.clock.now().toISOString(), target: "system-map", id: file, ...entry };
    return this.d.fs.append(editLogOf(file), serializeJsonLine(PlanEditDocument.stamp(line)));
  }

  private async viewOf(map: SystemMap | null): Promise<SystemMapView> {
    return {
      map,
      digest: map ? documentDigest(map) : null,
      lint: map ? mapLintView(map, this.d.kinds) : { problems: [] },
      roots: [...(await this.d.roots())],
      file: this.d.location.source,
      editable: this.d.location.local,
      ...(this.d.location.local
        ? {}
        : { readOnlyBecause: "the map is pinned in another repository: change it there" }),
    };
  }
}

const basename = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? path;
