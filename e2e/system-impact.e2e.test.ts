/**
 * `metator system impact|sources|lint --fetch` end to end (F7.3): three real repositories in a
 * folder. The map lives in the platform repository; billing and web point to it at a pinned ref
 * (`system.map: { repo, ref, path }`, read from a clone). A change to billing's specification
 * reaches web, its consumer, and both owners; the platform checks billing's specification in a
 * clone pinned to `main`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";

const SPEC = "openapi: 3.0.3\ninfo: { title: Billing API, version: 2.0.0 }\npaths: {}\n";
const MAP = `kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: billing
    kind: service
    source: { repo: ../billing, ref: main }
    owners: ["@billing-team"]
  - id: web
    kind: frontend
    source: { repo: ../web }
    owners: ["@web-team"]
    consumes: [billing-api@^2]
contracts:
  - id: billing-api
    kind: openapi
    owner: billing
    spec: { path: openapi.yaml }
`;
const POINT =
  "kind: MetatorConfig\nschemaVersion: 4\nsystem:\n  map: { repo: ../platform, ref: main, path: docs/metator/system.yml }\n";

let folder: string;
const at = (name: string) => join(folder, name);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });

interface Impact {
  map: string;
  self: string[];
  applications: { id: string; reasons: string[]; owners: string[] }[];
  contracts: { id: string; owner: string; change: string; consumers: { app: string; version?: string }[] }[];
  unmapped: string[];
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-impact-"));
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  await repo("platform", { "docs/metator/system.yml": MAP, ".gitignore": ".metator/\n" });
  await repo("billing", {
    "openapi.yaml": SPEC,
    "src/server.ts": "export const s = 1;\n",
    "metator.config.yml": POINT,
    ".gitignore": ".metator/\n",
  });
  await repo("web", {
    "src/main.ts": "export const m = 1;\n",
    "metator.config.yml": POINT,
    ".gitignore": ".metator/\n",
  });
});
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("metator system impact (real CLI, three repositories, pinned map)", () => {
  test("a change to billing's specification reaches web and both owners; the map comes from a pinned clone", async () => {
    await Bun.write(
      join(at("billing"), "openapi.yaml"),
      SPEC.replace("paths: {}", "paths:\n  /invoices: {}"),
    );
    const r = await metator(["system", "impact"], at("billing"));
    expect(r.code).toBe(0);
    const i = r.json.data as Impact;
    expect(i.map).toBe("../platform@main:docs/metator/system.yml");
    expect(i.self).toEqual(["billing"]);
    expect(i.contracts).toEqual([
      { id: "billing-api", owner: "billing", change: "spec", consumers: [{ app: "web", version: "^2" }] },
    ]);
    expect(i.applications.map((a) => [a.id, a.owners])).toEqual([
      ["billing", ["@billing-team"]],
      ["web", ["@web-team"]],
    ]);
    expect(i.applications[1]?.reasons).toEqual(["consumes billing-api@^2 (spec)"]);
    git(at("billing"), "checkout", "--", "openapi.yaml");
  }, 90_000);

  test("a change to billing's code is an implementation change; named contracts work from a consumer", async () => {
    const code = (await metator(["system", "impact", "--files", "src/server.ts", "README.md"], at("billing")))
      .json.data as Impact;
    expect([code.contracts[0]?.change, code.unmapped]).toEqual(["implementation", []]);
    const web = (await metator(["system", "impact", "--contracts", "billing-api"], at("web"))).json
      .data as Impact;
    expect([web.self, web.contracts.map((c) => [c.id, c.change])]).toEqual([
      ["web"],
      [["billing-api", "named"]],
    ]);
    const bad = await metator(["system", "impact", "--contracts", "nope"], at("web"));
    expect((bad.json.error as { message: string }).message).toBe("unknown contract nope");
  }, 90_000);

  test("in the platform repository: sources and lint, with billing pinned to main", async () => {
    const sources = (await metator(["system", "sources"], at("platform"))).json as {
      data: { sources: { app: string; via: string }[] };
      warnings: string[];
    };
    expect(sources.data.sources.map((s) => [s.app, s.via])).toEqual([
      ["billing", "none"],
      ["web", "local"],
    ]);
    expect(sources.warnings).toEqual([
      "billing has no checkout here: set system.roots.billing or pass --fetch",
    ]);
    const unchecked = (await metator(["system", "lint"], at("platform"))).json.data as {
      unchecked: string[];
    };
    expect(unchecked.unchecked).toEqual(["billing-api: openapi.yaml in ../billing"]);
    const fetched = await metator(["system", "lint", "--fetch"], at("platform"));
    expect([
      fetched.code,
      (fetched.json.data as { unchecked: string[]; problems: unknown[] }).unchecked,
    ]).toEqual([0, []]);
    const fetchedSources = (await metator(["system", "sources", "--fetch"], at("platform"))).json.data as {
      sources: { app: string; via: string; root: string }[];
    };
    expect(fetchedSources.sources[0]?.via).toBe("clone");
    expect(await Bun.file(join(fetchedSources.sources[0]?.root as string, "openapi.yaml")).text()).toBe(SPEC);

    // A configured checkout wins over the clone.
    await Bun.write(
      join(at("platform"), "metator.config.yml"),
      "kind: MetatorConfig\nschemaVersion: 4\nsystem:\n  roots: { billing: ../billing }\n",
    );
    const local = (await metator(["system", "sources"], at("platform"))).json.data as {
      sources: { app: string; via: string }[];
    };
    expect(local.sources[0]?.via).toBe("local");
  }, 120_000);
});

describe("library changes and checkouts side by side (real CLI)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "metator-impact-lib-"));
    const repo = async (name: string, files: Record<string, string>, remote?: string) => {
      for (const [p, t] of Object.entries(files)) await Bun.write(join(dir, name, p), t);
      git(join(dir, name), "init", "-q", "-b", "main");
      if (remote) git(join(dir, name), "remote", "add", "origin", remote);
      git(join(dir, name), "add", "-A");
      git(join(dir, name), "commit", "-q", "-m", "init");
    };
    // The web application imports a library package; the API lives in a repository next to it.
    await repo("shop", {
      ".gitignore": ".metator/\n",
      "package.json": `${JSON.stringify({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] })}\n`,
      "apps/web/package.json": `${JSON.stringify({ name: "web", dependencies: { ui: "*" } })}\n`,
      "apps/web/src/main.ts":
        'import { button } from "../../../packages/ui/src/button";\nexport const m = button;\n',
      "packages/ui/package.json": `${JSON.stringify({ name: "ui", main: "src/button.ts" })}\n`,
      "packages/ui/src/button.ts": "export const button = 1;\n",
      "docs/metator/system.yml":
        "kind: SystemMap\nschemaVersion: 1\nsystem: shop\napplications:\n  - id: web\n    source: { path: apps/web }\n  - id: api\n    source: { repo: https://github.com/acme/api }\n",
      "metator.config.yml":
        "kind: MetatorConfig\nschemaVersion: 4\nsystem:\n  map: { path: docs/metator/system.yml }\n",
    });
    await repo("api", { "src/server.ts": "export const s = 1;\n" }, "git@github.com:acme/api.git");
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a changed library file reaches the application that imports it; it is not unmapped", async () => {
    const r = await metator(["system", "impact", "--files", "packages/ui/src/button.ts"], join(dir, "shop"));
    const i = r.json.data as Impact;
    expect([i.applications.map((a) => [a.id, a.reasons]), i.unmapped]).toEqual([
      [["web", ["uses packages/ui/src/button.ts, which changed"]]],
      [],
    ]);
  }, 60_000);

  test("the repository cloned next to this one with the map's remote is that application's checkout", async () => {
    const r = await metator(["system", "sources"], join(dir, "shop"));
    const sources = (r.json.data as { sources: { app: string; via: string; root?: string }[] }).sources;
    expect(sources.find((s) => s.app === "api")).toMatchObject({ via: "local", root: join(dir, "api") });
  }, 60_000);
});
