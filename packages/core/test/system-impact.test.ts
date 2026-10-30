import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { LintSystem, SystemCatalog } from "../src/application/system.ts";
import {
  absolute,
  CloneCache,
  LocalSystemLocation,
  PinnedSystemLocation,
  SystemImpactQuery,
  SystemSources,
} from "../src/application/system-sources.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import {
  cloneDir,
  impactOf,
  relativeRepository,
  sameRepository,
  selfApplications,
} from "../src/domain/system-impact.ts";
import { cleanPath, inDir, SystemMapSchema } from "../src/domain/system-map.ts";
import type { CheckoutReader, RepositoryCloner } from "../src/ports/index.ts";

const MAP = SystemMapSchema.parse({
  system: "shop",
  applications: [
    { id: "billing", source: { path: "apps/billing" }, owners: ["@b"] },
    { id: "pricing", source: { path: "apps/billing/pricing" } },
    {
      id: "web",
      source: { repo: "git@github.com:acme/web.git" },
      owners: ["@w"],
      consumes: ["billing-api@^2", "prices"],
    },
    { id: "mail", source: { repo: "../mail", path: "svc" }, consumes: ["billing-api"] },
  ],
  contracts: [
    { id: "billing-api", kind: "openapi", owner: "billing", spec: { path: "openapi.yaml" } },
    { id: "prices", kind: "openapi", owner: "pricing", spec: { path: "prices.yaml" } },
  ],
});
const at = (id: string) => MAP.applications.find((a) => a.id === id) as (typeof MAP.applications)[number];

describe("system impact domain", () => {
  test("one repository, written as SSH, HTTPS (with a user) or bare host path", () => {
    expect(sameRepository("git@github.com:acme/web.git", "https://github.com/acme/web")).toBe(true);
    expect(sameRepository("github.com/Acme/Web/", "ssh://git@github.com/acme/web.git")).toBe(true);
    expect(sameRepository("https://bot@github.com/acme/web.git/", "github.com/acme/web")).toBe(true);
    expect(sameRepository("github.com/acme/web", "github.com/acme/api")).toBe(false);
  });

  test("a repository relative to another one's URL, in every form; never above the host", () => {
    expect(relativeRepository("https://github.com/acme/platform.git", "../billing")).toBe(
      "https://github.com/acme/billing",
    );
    expect(relativeRepository("git@github.com:acme/platform.git", "../billing")).toBe(
      "git@github.com:acme/billing",
    );
    expect(relativeRepository("github.com/acme/platform", "./../x/./y")).toBe("github.com/acme/x/y");
    expect(relativeRepository("https://github.com/acme", "../../x")).toBeUndefined();
  });

  test("paths as the map writes them: ./web and web/ are web", () => {
    expect([
      cleanPath("./web/"),
      cleanPath("./"),
      inDir("./apps/billing/", "./openapi.yaml"),
      inDir(".", "a.yml"),
    ]).toEqual(["web", ".", "apps/billing/openapi.yaml", "a.yml"]);
    const odd = SystemMapSchema.parse({
      system: "s",
      applications: [{ id: "billing", source: { path: "./apps/billing/" } }],
      contracts: [{ id: "api", kind: "openapi", owner: "billing", spec: { path: "./openapi.yaml" } }],
    });
    const i = impactOf(odd, { self: odd.applications, files: ["apps/billing/openapi.yaml"] });
    expect([
      i.applications.map((a) => [a.id, a.changed]),
      i.contracts.map((c) => c.change),
      i.unmapped,
    ]).toEqual([[["billing", true]], ["spec"], []]);
  });

  test("self: configured ids, a matching remote or path, and path applications only with a local map", () => {
    const here = {
      root: "/src/mail",
      mapIsLocal: false,
      resolve: (r: string) => absolute("/src/platform", r),
    };
    expect(selfApplications(MAP, { ...here, configured: ["web"] }).map((a) => a.id)).toEqual(["web"]);
    expect(
      selfApplications(MAP, { ...here, remote: "https://github.com/acme/web" }).map((a) => a.id),
    ).toEqual(["web", "mail"]);
    expect(selfApplications(MAP, here).map((a) => a.id)).toEqual(["mail"]);
    expect(
      selfApplications(MAP, { ...here, root: "/src/platform", mapIsLocal: true }).map((a) => a.id),
    ).toEqual(["billing", "pricing"]);
  });

  test("a changed specification reaches its consumers; the deepest application owns a file", () => {
    const i = impactOf(MAP, {
      self: [at("billing"), at("pricing")],
      files: ["apps/billing/pricing/prices.yaml", "apps/billing/src/a.ts", "docs/x.md"],
    });
    expect(i.contracts).toEqual([
      {
        id: "billing-api",
        owner: "billing",
        change: "implementation",
        consumers: [{ app: "web", version: "^2" }, { app: "mail" }],
      },
      { id: "prices", owner: "pricing", change: "spec", consumers: [{ app: "web" }] },
    ]);
    expect(i.applications.map((a) => [a.id, a.reasons])).toEqual([
      ["billing", ["its files changed (apps/billing/src/a.ts)", "provides billing-api"]],
      ["pricing", ["its files changed (apps/billing/pricing/prices.yaml)", "provides prices"]],
      ["web", ["consumes billing-api@^2 (implementation)", "consumes prices (spec)"]],
      ["mail", ["consumes billing-api (implementation)"]],
    ]);
    expect(i.unmapped).toEqual(["docs/x.md"]);
  });

  test("a changed library reaches the applications whose files import it, and their contracts", () => {
    const i = impactOf(MAP, {
      self: [at("billing"), at("pricing")],
      files: ["packages/money/round.ts", "docs/x.md"],
      usedBy: (f) =>
        f === "packages/money/round.ts" ? ["packages/money/index.ts", "apps/billing/src/a.ts"] : [],
    });
    expect(i.applications.map((a) => [a.id, a.changed, a.reasons[0]])).toEqual([
      ["billing", true, "uses packages/money/round.ts, which changed"],
      ["web", false, "consumes billing-api@^2 (implementation)"],
      ["mail", false, "consumes billing-api (implementation)"],
    ]);
    expect(i.unmapped).toEqual(["docs/x.md"]);
  });

  test("a spec change wins over an implementation change; named contracts; a whole-repository application", () => {
    const i = impactOf(MAP, {
      self: [at("billing")],
      files: ["apps/billing/openapi.yaml", "apps/billing/src/a.ts"],
      contracts: ["prices"],
    });
    expect(i.contracts.map((c) => [c.id, c.change])).toEqual([
      ["billing-api", "spec"],
      ["prices", "named"],
    ]);
    const whole = SystemMapSchema.parse({ system: "s", applications: [{ id: "a", source: { repo: "x" } }] });
    expect(
      impactOf(whole, { self: whole.applications, files: ["any/file.ts"] }).applications.map((a) => a.id),
    ).toEqual(["a"]);
  });

  test("clone directories are named after the repository and commit", () => {
    expect(cloneDir("git@github.com:acme/web.git", "0123456789abcdef0123")).toBe("acme-web@0123456789ab");
    expect(cloneDir("../billing", "ffffffffffffffff")).toBe("..-billing@ffffffffffff");
    expect(absolute("/src/platform/.metator", "../../billing/./x")).toBe("/src/billing/x");
  });
});

class FakeCloner implements RepositoryCloner {
  readonly calls: string[] = [];
  constructor(private readonly fail?: string) {}
  async resolve(repo: string, ref?: string) {
    this.calls.push(`resolve ${repo} ${ref ?? ""}`.trim());
    return this.fail ? err(new MetatorError("COMMAND_FAILED", this.fail)) : ok("a".repeat(40));
  }
  async checkout(repo: string, sha: string, dir: string) {
    this.calls.push(`checkout ${repo} ${sha.slice(0, 4)} ${dir}`);
    return ok(undefined);
  }
}
class FakeReader implements CheckoutReader {
  constructor(
    private readonly files: Record<string, string>,
    private readonly dirs: readonly string[] = [],
  ) {}
  async read(root: string, path: string) {
    return ok(this.files[`${root}/${path}`]);
  }
  async isDirectory(path: string) {
    return this.dirs.includes(path);
  }
}
const YAML = `kind: SystemMap\nschemaVersion: 1\nsystem: shop\napplications:\n  - id: billing\n    source: { repo: ../billing, ref: main }\n  - id: web\n    source: { repo: ../web }\n    consumes: [billing-api]\ncontracts:\n  - id: billing-api\n    kind: openapi\n    owner: billing\n    spec: { path: openapi.yaml }\n`;
const CACHE = "/src/web/.metator/system";
const CLONE = `${CACHE}/src-platform@aaaaaaaaaaaa`;
const noRemote = { remoteUrl: async () => ok(undefined) };
const remote = (url: string) => ({ remoteUrl: async () => ok(url) });

describe("where the map and the applications are", () => {
  test("a pinned map is read from one clone of its commit; relative repositories start at the platform", async () => {
    const cloner = new FakeCloner();
    const reader = new FakeReader({ [`${CLONE}/docs/metator/system.yml`]: YAML });
    const location = new PinnedSystemLocation(
      { repo: "../platform", ref: "main", path: "docs/metator/system.yml" },
      "/src/web",
      new CloneCache(cloner, CACHE),
      reader,
    );
    expect(location.source).toBe("../platform@main:docs/metator/system.yml");
    const map = (await location.load())._unsafeUnwrap();
    expect(map?.applications.map((a) => a.id)).toEqual(["billing", "web"]);
    await location.root();
    // The ref is resolved once: the map and every specification are read at one commit.
    expect(cloner.calls).toEqual([
      "resolve /src/platform main",
      `checkout /src/platform aaaa ${CLONE}`,
      `checkout /src/platform aaaa ${CLONE}`,
    ]);
    expect(location.resolveRepo("../billing")._unsafeUnwrap()).toBe("/src/billing");
    const url = new PinnedSystemLocation(
      { repo: "https://github.com/acme/platform.git", path: "m.yml" },
      "/src/web",
      new CloneCache(new FakeCloner(), CACHE),
      reader,
    );
    expect(url.resolveRepo("../billing")._unsafeUnwrap()).toBe("https://github.com/acme/billing");
    expect(url.resolveRepo("../../../x")._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await url.load())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const unreachable = new PinnedSystemLocation(
      { repo: "../p", path: "m.yml" },
      "/src/web",
      new CloneCache(new FakeCloner("no route"), CACHE),
      reader,
    );
    expect((await unreachable.load())._unsafeUnwrapErr().message).toBe("no route");
    const local = new LocalSystemLocation(new SystemCatalog(new InMemoryFileSystem(), "m.yml"), "/r");
    expect((await local.require())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("an application's code: a configured root, this repository, a path checkout, a clone only with fetch", async () => {
    const map = SystemMapSchema.parse({
      system: "s",
      applications: [
        { id: "billing", source: { repo: "../billing", ref: "main" } },
        { id: "web", source: { repo: "../web" } },
        { id: "api", source: { repo: "git@x:acme/api.git", path: "svc" } },
        { id: "docs", source: { path: "./docs/" } },
        { id: "shop", source: { repo: "git@github.com:acme/shop.git" } },
      ],
    });
    const app = (id: string) =>
      map.applications.find((a) => a.id === id) as (typeof map.applications)[number];
    const location = new LocalSystemLocation({ source: "m.yml", load: async () => ok(map) }, "/src/platform");
    const cloner = new FakeCloner();
    const sources = new SystemSources(
      { roots: { api: "../api-checkout" } },
      "/src/platform",
      location,
      new CloneCache(cloner, CACHE),
      new FakeReader({}, ["/src/web", "/src/api-checkout"]),
      remote("https://github.com/acme/shop"),
    );
    expect((await sources.locate(app("api")))._unsafeUnwrap()).toEqual({
      app: "api",
      root: "/src/api-checkout",
      dir: "svc",
      via: "local",
    });
    expect((await sources.locate(app("web")))._unsafeUnwrap()).toEqual({
      app: "web",
      root: "/src/web",
      dir: ".",
      via: "local",
    });
    expect((await sources.locate(app("docs")))._unsafeUnwrap()).toEqual({
      app: "docs",
      root: "/src/platform",
      dir: "docs",
      via: "here",
    });
    // The map names this repository by its remote: locate agrees with self.
    expect((await sources.locate(app("shop")))._unsafeUnwrap()?.via).toBe("here");
    expect((await sources.self(map))._unsafeUnwrap().map((a) => a.id)).toEqual(["docs", "shop"]);
    expect((await sources.locate(app("billing")))._unsafeUnwrap()).toBeUndefined();
    expect((await sources.locate(app("billing"), { fetch: true }))._unsafeUnwrap()).toEqual({
      app: "billing",
      root: `${CACHE}/src-billing@aaaaaaaaaaaa`,
      dir: ".",
      via: "clone",
    });
    // Cloned side by side: ../shop-web with the remote the map names is that application's checkout.
    const beside = new SystemSources(
      undefined,
      "/src/platform",
      location,
      new CloneCache(cloner, CACHE),
      new FakeReader(
        {
          "/src/shop-web/.git/config": '[remote "origin"]\n\turl = git@github.com:acme/shop-web.git\n',
          "/src/other/.git/config": '[remote "origin"]\n\turl = https://github.com/someone/other\n',
        },
        ["/src/shop-web", "/src/other"],
      ),
      noRemote,
    );
    const app2 = (repo: string, ref?: string) =>
      SystemMapSchema.parse({
        system: "s",
        applications: [{ id: "w", source: { repo, ...(ref ? { ref } : {}) } }],
      }).applications[0] as (typeof map.applications)[number];
    expect((await beside.locate(app2("https://github.com/acme/shop-web")))._unsafeUnwrap()).toEqual({
      app: "w",
      root: "/src/shop-web",
      dir: ".",
      via: "local",
    });
    // Another remote, or a pinned commit: not this checkout.
    expect((await beside.locate(app2("https://github.com/acme/other")))._unsafeUnwrap()).toBeUndefined();
    expect(
      (await beside.locate(app2("https://github.com/acme/shop-web", "main")))._unsafeUnwrap(),
    ).toBeUndefined();
    const all = (await sources.locateAll())._unsafeUnwrap();
    expect(all.sources.map((s) => [s.app, s.via])).toEqual([
      ["billing", "none"],
      ["web", "local"],
      ["api", "local"],
      ["docs", "here"],
      ["shop", "here"],
    ]);
  });

  test("impact query: changed files from git or given, named contracts checked, no map is NOT_FOUND", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/system.yml": YAML.replace("repo: ../billing, ref: main", "path: ."),
    });
    const location = new LocalSystemLocation(
      new SystemCatalog(fs, "docs/metator/system.yml"),
      "/src/billing",
    );
    const vcs = { changedFiles: async () => ok(["openapi.yaml"]) };
    const sources = (settings?: { roots: Record<string, string>; self?: string[] }) =>
      new SystemSources(
        settings,
        "/src/billing",
        location,
        new CloneCache(new FakeCloner(), CACHE),
        new FakeReader({}),
        noRemote,
      );
    const q = new SystemImpactQuery(sources(), vcs);
    const r = (await q.execute({ base: "main" }))._unsafeUnwrap();
    expect([r.base, r.self, r.contracts.map((c) => [c.id, c.change])]).toEqual([
      "main",
      ["billing"],
      [["billing-api", "spec"]],
    ]);
    const files = (await q.execute({ files: ["README.md"] }))._unsafeUnwrap();
    expect([files.base, files.unmapped, files.contracts.map((c) => [c.id, c.change])]).toEqual([
      null,
      [],
      [["billing-api", "implementation"]],
    ]);
    expect((await q.execute({ contracts: ["nope"] }))._unsafeUnwrapErr().message).toBe(
      "unknown contract nope",
    );
    const configured = new SystemImpactQuery(sources({ roots: {}, self: ["web"] }), vcs);
    expect((await configured.execute({ base: "main" }))._unsafeUnwrap().self).toEqual(["web"]);
    const none = new LocalSystemLocation(new SystemCatalog(new InMemoryFileSystem(), "x.yml"), "/r");
    const empty = new SystemImpactQuery(
      new SystemSources(
        undefined,
        "/r",
        none,
        new CloneCache(new FakeCloner(), CACHE),
        new FakeReader({}),
        noRemote,
      ),
      vcs,
    );
    expect((await empty.execute({}))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("impact query: a changed library file reaches the application through the import graph", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/system.yml":
        "kind: SystemMap\nschemaVersion: 1\nsystem: s\napplications:\n  - id: web\n    source: { path: apps/web }\n",
    });
    const location = new LocalSystemLocation(new SystemCatalog(fs, "docs/metator/system.yml"), "/r");
    const sources = new SystemSources(
      undefined,
      "/r",
      location,
      new CloneCache(new FakeCloner(), CACHE),
      new FakeReader({}),
      noRemote,
    );
    const graph = {
      read: async () =>
        ok([
          { from: "apps/web/main.ts", to: "packages/ui/index.ts", kind: "internal" as const },
          { from: "packages/ui/index.ts", to: "packages/ui/button.ts", kind: "internal" as const },
        ]),
    };
    const vcs = { changedFiles: async () => ok([]) };
    const r = (
      await new SystemImpactQuery(sources, vcs, graph).execute({ files: ["packages/ui/button.ts"] })
    )._unsafeUnwrap();
    expect([r.applications.map((a) => [a.id, a.reasons]), r.unmapped]).toEqual([
      [["web", ["uses packages/ui/button.ts, which changed"]]],
      [],
    ]);
    // Without the graph the file belongs to no application.
    expect(
      (
        await new SystemImpactQuery(sources, vcs).execute({ files: ["packages/ui/button.ts"] })
      )._unsafeUnwrap().unmapped,
    ).toEqual(["packages/ui/button.ts"]);
  });

  test("lint checks every specification where its provider's code is: here, a checkout or a clone", async () => {
    const fs = new InMemoryFileSystem({ "m.yml": YAML });
    const location = new LocalSystemLocation(new SystemCatalog(fs, "m.yml"), "/src/platform");
    const clone = `${CACHE}/src-billing@aaaaaaaaaaaa`;
    const reader = new FakeReader({ [`${clone}/openapi.yaml`]: "openapi: 3.0.0" }, ["/src/web"]);
    const sources = (r: FakeReader) =>
      new SystemSources(
        undefined,
        "/src/platform",
        location,
        new CloneCache(new FakeCloner(), CACHE),
        r,
        noRemote,
      );
    const lint = new LintSystem(sources(reader), fs, ["openapi"], reader);
    expect((await lint.execute())._unsafeUnwrap().unchecked).toEqual([
      "billing-api: openapi.yaml in ../billing",
    ]);
    const fetched = (await lint.execute({ fetch: true }))._unsafeUnwrap();
    expect([fetched.unchecked, fetched.problems]).toEqual([[], []]);
    const bare = new FakeReader({});
    const missing = new LintSystem(sources(bare), fs, ["openapi"], bare);
    expect((await missing.execute({ fetch: true }))._unsafeUnwrap().problems.map((p) => p.message)).toEqual([
      'contract "billing-api": specification openapi.yaml does not exist in ../billing (clone)',
    ]);
  });
});
