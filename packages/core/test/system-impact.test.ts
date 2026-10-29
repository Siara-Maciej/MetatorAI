import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { LintSystem, SystemCatalog } from "../src/application/system.ts";
import {
  absolute,
  LocalSystemLocation,
  PinnedSystemLocation,
  SystemImpactQuery,
  SystemSources,
} from "../src/application/system-sources.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import { cloneDir, impactOf, sameRepository, selfApplications } from "../src/domain/system-impact.ts";
import { SystemMapSchema } from "../src/domain/system-map.ts";
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
  test("one repository, written as SSH, HTTPS or bare host path", () => {
    expect(sameRepository("git@github.com:acme/web.git", "https://github.com/acme/web")).toBe(true);
    expect(sameRepository("github.com/Acme/Web/", "ssh://git@github.com/acme/web.git")).toBe(false); // ssh:// keeps the user
    expect(sameRepository("github.com/acme/web", "github.com/acme/api")).toBe(false);
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
const CLONE = `${CACHE}/..-platform@aaaaaaaaaaaa`;

describe("where the map and the applications are", () => {
  test("a pinned map is read from its clone; relative repositories start where the platform is", async () => {
    const cloner = new FakeCloner();
    const reader = new FakeReader({ [`${CLONE}/docs/metator/system.yml`]: YAML });
    const location = new PinnedSystemLocation(
      { repo: "../platform", ref: "main", path: "docs/metator/system.yml" },
      "/src/web",
      CACHE,
      cloner,
      reader,
    );
    expect(location.source).toBe("../platform@main:docs/metator/system.yml");
    const map = (await location.load())._unsafeUnwrap();
    expect(map?.applications.map((a) => a.id)).toEqual(["billing", "web"]);
    expect(cloner.calls).toEqual(["resolve /src/platform main", `checkout /src/platform aaaa ${CLONE}`]);
    expect((await location.repoBase())._unsafeUnwrap()).toBe("/src/platform");
    const url = new PinnedSystemLocation(
      { repo: "git@x:p.git", path: "m.yml" },
      "/src/web",
      CACHE,
      new FakeCloner(),
      reader,
    );
    expect((await url.repoBase())._unsafeUnwrap()).toBe(`${CACHE}/git-x-p@aaaaaaaaaaaa`);
    expect((await url.load())._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    const unreachable = new PinnedSystemLocation(
      { repo: "../p", path: "m.yml" },
      "/src/web",
      CACHE,
      new FakeCloner("no route"),
      reader,
    );
    expect((await unreachable.load())._unsafeUnwrapErr().message).toBe("no route");
  });

  test("an application's code: a configured root, a path checkout, a clone only with fetch", async () => {
    const map = SystemMapSchema.parse({
      system: "s",
      applications: [
        { id: "billing", source: { repo: "../billing", ref: "main" } },
        { id: "web", source: { repo: "../web" } },
        { id: "api", source: { repo: "git@x:api.git", path: "svc" } },
        { id: "docs", source: { path: "docs" } },
      ],
    });
    const app = (id: string) =>
      map.applications.find((a) => a.id === id) as (typeof map.applications)[number];
    const location = new LocalSystemLocation(
      new SystemCatalog(new InMemoryFileSystem(), "m.yml"),
      "/src/platform",
    );
    const cloner = new FakeCloner();
    const sources = new SystemSources(
      { roots: { api: "../api-checkout" } },
      "/src/platform",
      CACHE,
      cloner,
      new FakeReader({}, ["/src/web", "/src/api-checkout"]),
    );
    expect((await sources.locate(app("api"), location))._unsafeUnwrap()).toEqual({
      app: "api",
      root: "/src/api-checkout",
      dir: "svc",
      via: "local",
    });
    expect((await sources.locate(app("web"), location))._unsafeUnwrap()).toEqual({
      app: "web",
      root: "/src/web",
      dir: ".",
      via: "local",
    });
    expect((await sources.locate(app("docs"), location))._unsafeUnwrap()).toEqual({
      app: "docs",
      root: "/src/platform",
      dir: "docs",
      via: "here",
    });
    expect((await sources.locate(app("billing"), location))._unsafeUnwrap()).toBeUndefined();
    const cloned = (await sources.locate(app("billing"), location, { fetch: true }))._unsafeUnwrap();
    expect(cloned).toEqual({
      app: "billing",
      root: `${CACHE}/src-billing@aaaaaaaaaaaa`,
      dir: ".",
      via: "clone",
    });
    const noRoots = new SystemSources(undefined, "/src/platform", CACHE, cloner, new FakeReader({}));
    expect((await noRoots.locate(app("api"), location))._unsafeUnwrap()).toBeUndefined();
    expect((await noRoots.locate(app("api"), location, { fetch: true }))._unsafeUnwrap()?.via).toBe("clone");
  });

  test("impact query: changed files from git or given, named contracts checked, no map is NOT_FOUND", async () => {
    const fs = new InMemoryFileSystem({
      "docs/metator/system.yml": YAML.replace("repo: ../billing, ref: main", "path: ."),
    });
    const location = new LocalSystemLocation(
      new SystemCatalog(fs, "docs/metator/system.yml"),
      "/src/billing",
    );
    const vcs = { changedFiles: async () => ok(["openapi.yaml"]), remoteUrl: async () => ok(undefined) };
    const q = new SystemImpactQuery(location, vcs, undefined, "/src/billing");
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
    const configured = new SystemImpactQuery(location, vcs, { roots: {}, self: ["web"] }, "/src/billing");
    expect((await configured.execute({ base: "main" }))._unsafeUnwrap().self).toEqual(["web"]);
    const empty = new SystemImpactQuery(
      new LocalSystemLocation(new SystemCatalog(new InMemoryFileSystem(), "x.yml"), "/r"),
      vcs,
      undefined,
      "/r",
    );
    expect((await empty.execute({}))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });

  test("lint checks a specification in another repository's checkout or clone", async () => {
    const fs = new InMemoryFileSystem({ "m.yml": YAML });
    const catalog = new SystemCatalog(fs, "m.yml");
    const location = new LocalSystemLocation(catalog, "/src/platform");
    const cloner = new FakeCloner();
    const clone = `${CACHE}/src-billing@aaaaaaaaaaaa`;
    const reader = new FakeReader({ [`${clone}/openapi.yaml`]: "openapi: 3.0.0" }, ["/src/web"]);
    const lint = new LintSystem(catalog, fs, ["openapi"], {
      location,
      sources: new SystemSources(undefined, "/src/platform", CACHE, cloner, reader),
      reader,
    });
    expect((await lint.execute())._unsafeUnwrap().unchecked).toEqual([
      "billing-api: openapi.yaml in ../billing",
    ]);
    const fetched = (await lint.execute({ fetch: true }))._unsafeUnwrap();
    expect([fetched.unchecked, fetched.problems]).toEqual([[], []]);
    const missing = new LintSystem(catalog, fs, ["openapi"], {
      location,
      sources: new SystemSources(undefined, "/src/platform", CACHE, cloner, new FakeReader({})),
      reader: new FakeReader({}),
    });
    expect((await missing.execute({ fetch: true }))._unsafeUnwrap().problems.map((p) => p.message)).toEqual([
      'contract "billing-api": specification openapi.yaml does not exist in ../billing (clone)',
    ]);
  });
});
