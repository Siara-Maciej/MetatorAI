import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { SystemCatalog } from "../src/application/system.ts";
import type { DiscoverySource } from "../src/application/system-discovery.ts";
import { SystemMaps } from "../src/application/system-map-edit.ts";
import { LocalSystemLocation } from "../src/application/system-sources.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { documentDigest, editLogOf, PlanEditDocument } from "../src/domain/plan-edit.ts";
import { err, ok } from "../src/domain/result.ts";
import { type SystemMap, SystemMapDocument } from "../src/domain/system-map.ts";

const FILE = "docs/metator/system.yml";
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: api, source: { path: apps/api } }
contracts:
  - { id: prices, kind: openapi, owner: api, spec: { path: openapi.yaml } }
`;
const PROPOSAL = SystemMapDocument.parse(Bun.YAML.parse(MAP), "m")._unsafeUnwrap();

function world(files: Record<string, string> = { [FILE]: MAP }, local = true) {
  const fs = new InMemoryFileSystem(files);
  const location = new LocalSystemLocation(new SystemCatalog(fs, FILE), "/src/api");
  const asked: { sources: number; system: string; write: boolean }[] = [];
  const source = (name: string) => ({ name }) as unknown as DiscoverySource;
  const maps = new SystemMaps({
    fs,
    location: { source: FILE, local, load: () => location.load() },
    kinds: ["openapi"],
    roots: async () => ["/src/api", "/src/web"],
    discover: {
      execute: async (input) => {
        asked.push({ sources: input.sources.length, system: input.system, write: input.write ?? false });
        const there = await input.map?.load();
        const exists = there?.isOk() && there.value !== undefined;
        // As DiscoverSystem: writing over an existing map is refused.
        if (input.write && exists) return err(MetatorError.usage(`${FILE} already exists`));
        return ok({
          proposal: PROPOSAL,
          evidence: [],
          map: FILE,
          drift: exists ? ["web is not in the map"] : [],
          ...(input.write && !exists ? { written: FILE } : {}),
        } as never);
      },
    },
    here: source("api"),
    sourceAt: (root) => source(root),
    system: "api",
    clock: new FixedClock(new Date("2026-11-15T10:00:00.000Z")),
  });
  return { fs, maps, asked };
}

const edits = async (fs: InMemoryFileSystem) =>
  (await fs.read(editLogOf(FILE)))
    ._unsafeUnwrap()
    .trim()
    .split("\n")
    .map((l) => PlanEditDocument.parse(JSON.parse(l), "log")._unsafeUnwrap());

describe("the system map in the app", () => {
  test("the view: the map, its digest, its lint by field, the roots, editable when it is this repository's", async () => {
    const w = world();
    const view = (await w.maps.view())._unsafeUnwrap();
    expect([view.digest, view.file, view.roots, view.editable]).toEqual([
      documentDigest(PROPOSAL),
      FILE,
      ["/src/api", "/src/web"],
      true,
    ]);
    expect(view.lint.problems).toEqual([]);
    const none = (await world({}).maps.view())._unsafeUnwrap();
    expect([none.map, none.digest]).toEqual([null, null]);
    const pinned = (await world({ [FILE]: MAP }, false).maps.view())._unsafeUnwrap();
    expect([pinned.editable, pinned.readOnlyBecause]).toEqual([
      false,
      "the map is pinned in another repository: change it there",
    ]);
  });

  test("a save writes the map, logs who changed which applications and contracts, and lints the result", async () => {
    const w = world();
    const map: SystemMap = {
      ...PROPOSAL,
      applications: [
        ...PROPOSAL.applications,
        {
          id: "web",
          source: { path: "apps/web" },
          consumes: ["nothing"],
        } as SystemMap["applications"][number],
      ],
    };
    const view = (await w.maps.save({ map, digest: documentDigest(PROPOSAL), by: "ana" }))._unsafeUnwrap();
    expect(view.digest).toBe(documentDigest(view.map));
    expect(view.lint.problems.map((p) => p.field)).toEqual(["applications.1.consumes.0"]);
    const saved = SystemMapDocument.parse(Bun.YAML.parse((await w.fs.read(FILE))._unsafeUnwrap()), FILE);
    expect(saved._unsafeUnwrap().applications.map((a) => a.id)).toEqual(["api", "web"]);
    expect(await edits(w.fs)).toEqual([
      {
        at: "2026-11-15T10:00:00.000Z",
        by: "ana",
        target: "system-map",
        id: FILE,
        before: documentDigest(PROPOSAL),
        after: view.digest as string,
        changes: ["application added: web"],
      },
    ]);
  });

  test("a stale digest is CONFLICT; an invalid map is USAGE by field; a pinned map is not changed here; nothing is written", async () => {
    const w = world();
    const stale = (await w.maps.save({ map: PROPOSAL, digest: null, by: "ana" }))._unsafeUnwrapErr();
    expect([stale.code, (stale.details as { current: { digest: string } }).current.digest]).toEqual([
      "CONFLICT",
      documentDigest(PROPOSAL),
    ]);
    const invalid = (
      await w.maps.save({
        map: { ...PROPOSAL, applications: [{ id: "x" }] },
        digest: documentDigest(PROPOSAL),
        by: "ana",
      })
    )._unsafeUnwrapErr();
    expect(invalid.code).toBe("USAGE");
    expect((invalid.details as { problems: { field: string }[] }).problems[0]?.field).toBe(
      "applications.0.source",
    );
    expect(
      (await w.maps.save({ map: PROPOSAL, digest: documentDigest(PROPOSAL), by: "" }))._unsafeUnwrapErr()
        .code,
    ).toBe("USAGE");
    expect((await w.fs.read(FILE))._unsafeUnwrap()).toBe(MAP);
    const pinned = world({ [FILE]: MAP }, false);
    expect(
      (
        await pinned.maps.save({ map: PROPOSAL, digest: documentDigest(PROPOSAL), by: "ana" })
      )._unsafeUnwrapErr().code,
    ).toBe("TRANSITION_DENIED");
    expect(await w.fs.exists(editLogOf(FILE))).toBe(false);
  });

  test("the first map is saved on digest null", async () => {
    const w = world({});
    const view = (await w.maps.save({ map: PROPOSAL, digest: null, by: "ana" }))._unsafeUnwrap();
    expect(view.map).toEqual(PROPOSAL);
    expect((await edits(w.fs))[0]?.changes).toEqual(["map written with 1 application(s)"]);
  });

  test("discover: this repository, or every repository of a folder; written only when there is no map, and logged", async () => {
    const here = world();
    // Asked to write over the map, it proposes and writes nothing.
    const over = (await here.maps.discover({ write: true, by: "ana" }))._unsafeUnwrap();
    expect([over.written, here.asked.at(-1)?.write]).toEqual([false, false]);
    here.asked.length = 0;
    const found = (await here.maps.discover({ write: false }))._unsafeUnwrap();
    expect(found.mapExists).toBe(true);
    // No map yet: the whole proposal is what the map lacks, so Write has something to add.
    const none = (await world({}).maps.discover({ write: false }))._unsafeUnwrap();
    expect(none.mapExists).toBe(false);
    expect(none.changes.length).toBeGreaterThan(0);
    expect(none.changes.every((c) => c.endsWith("is not in the map"))).toBe(true);
    expect([found.written, found.changes, here.asked]).toEqual([
      false,
      ["web is not in the map"],
      [{ sources: 1, system: "api", write: false }],
    ]);
    const empty = world({});
    const folder = { root: "/src/shop/", repos: ["/src/shop/api", "/src/shop/web"] };
    expect((await empty.maps.discover({ write: true, folder })).isErr()).toBe(true);
    const written = (await empty.maps.discover({ write: true, by: "ana", folder }))._unsafeUnwrap();
    expect([written.written, written.file, empty.asked.at(-1)]).toEqual([
      true,
      FILE,
      { sources: 2, system: "shop", write: true },
    ]);
    expect((await edits(empty.fs))[0]).toMatchObject({ by: "ana", before: null, target: "system-map" });
    const pinned = world({}, false);
    expect((await pinned.maps.discover({ write: true, by: "ana" }))._unsafeUnwrapErr().code).toBe(
      "TRANSITION_DENIED",
    );
  });
});
