/**
 * `metator system discover` end to end (F7.2): a monorepo with three applications and a folder of
 * three repositories, both with an OpenAPI contract and its consumer, proposed as a system map
 * with evidence; written once, then checked for drift.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const SPEC = `openapi: 3.0.3
info: { title: Billing API, version: 2.1.0 }
servers: [{ url: "https://billing.shop.internal/v2" }]
paths:
  /invoices: { get: { responses: { "200": { description: ok } } } }
`;

interface Discovery {
  topology: string;
  proposal: {
    system: string;
    applications: {
      id: string;
      kind: string;
      source: Record<string, string>;
      owners: string[];
      consumes: string[];
      deploy?: { unit: string };
    }[];
    contracts: { id: string; kind: string; owner: string; spec: { path: string }; compatibility: string }[];
  };
  evidence: { subject: string; confidence: string; proposed: boolean; file?: string }[];
  drift: string[];
  written?: string;
}

describe("metator system discover in a monorepo (real CLI)", () => {
  let repo: ScratchRepo;
  const mt = (...args: string[]) => metator(args, repo.root);
  beforeAll(async () => {
    repo = await ScratchRepo.create();
    await repo.write(".gitignore", ".metator/\nnode_modules/\n");
    await repo.write(
      "package.json",
      json({ name: "shop", private: true, workspaces: ["apps/*", "packages/*"] }),
    );
    await repo.write(".github/CODEOWNERS", "/apps/billing/ @billing-team\n/apps/web/ @web-team\n");
    await repo.write(
      "apps/web/package.json",
      json({
        name: "@shop/web",
        private: true,
        scripts: { dev: "vite", "gen:api": "openapi-typescript ../billing/openapi.yaml -o src/api.ts" },
        dependencies: { react: "19", "@shop/ui": "*" },
      }),
    );
    await repo.write(
      "apps/web/src/main.ts",
      'import { button } from "@shop/ui";\nexport const page = button;\n',
    );
    await repo.write(
      "apps/billing/package.json",
      json({
        name: "@shop/billing",
        private: true,
        scripts: { start: "bun src/server.ts" },
        dependencies: { hono: "4" },
      }),
    );
    await repo.write("apps/billing/src/server.ts", "export const server = 1;\n");
    await repo.write("apps/billing/openapi.yaml", SPEC);
    await repo.write("apps/billing/Dockerfile", "FROM oven/bun\n");
    await repo.write(
      "apps/notify-worker/package.json",
      json({ name: "@shop/notify-worker", private: true, scripts: { start: "bun src/index.ts" } }),
    );
    await repo.write(
      "apps/notify-worker/src/index.ts",
      'export const url = "https://billing.shop.internal/v2/invoices";\n',
    );
    await repo.write(
      "packages/ui/package.json",
      json({ name: "@shop/ui", private: true, main: "src/index.ts" }),
    );
    await repo.write("packages/ui/src/index.ts", "export const button = 1;\n");
    await repo.commit("init");
  });
  afterAll(async () => {
    await repo.dispose();
  });

  test("three applications, the billing contract and its consumer, with evidence", async () => {
    const r = await mt("system", "discover");
    expect(r.code).toBe(0);
    const d = r.json.data as Discovery;
    expect(d.topology).toBe("monorepo");
    expect(d.proposal.applications.map((a) => [a.id, a.kind, a.source.path, a.owners, a.consumes])).toEqual([
      ["billing", "service", "apps/billing", ["@billing-team"], []],
      ["notify-worker", "worker", "apps/notify-worker", [], []],
      ["web", "frontend", "apps/web", ["@web-team"], ["billing-api"]],
    ]);
    expect(d.proposal.applications[0]?.deploy?.unit).toBe("billing");
    expect(d.proposal.contracts).toEqual([
      {
        id: "billing-api",
        kind: "openapi",
        owner: "billing",
        spec: { path: "openapi.yaml" },
        compatibility: "backward",
      },
    ]);
    expect(d.evidence).toContainEqual(
      expect.objectContaining({
        subject: "consumes:web→billing-api",
        confidence: "medium",
        proposed: true,
        file: "apps/web/package.json",
      }),
    );
    // The worker calls the URL the specification names: shown, not proposed.
    expect(d.evidence).toContainEqual(
      expect.objectContaining({
        subject: "consumes:notify-worker→billing-api",
        confidence: "low",
        proposed: false,
      }),
    );
  }, 90_000);

  test("--write creates the map once; it lints; --check fails when an application is added", async () => {
    const w = await mt("system", "discover", "--write");
    expect((w.json.data as Discovery).written).toBe("docs/metator/system.yml");
    expect(await repo.read("docs/metator/system.yml")).toStartWith("# Proposed by `metator system discover`");
    expect((await mt("system", "lint")).code).toBe(0);
    const again = await mt("system", "discover", "--write");
    expect([again.code, (again.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    expect((await mt("system", "discover", "--check")).code).toBe(0);

    await repo.write(
      "apps/admin/package.json",
      json({ name: "@shop/admin", private: true, scripts: { dev: "vite" }, dependencies: { vue: "3" } }),
    );
    await repo.write("apps/admin/src/main.ts", "export const admin = 1;\n");
    await repo.git("add", "-A");
    const check = await mt("system", "discover", "--check");
    expect([check.code, (check.json.error as { details: { drift: string[] } }).details.drift]).toEqual([
      1,
      ["application admin is not in the map"],
    ]);
  }, 120_000);
});

describe("metator system discover in a folder of three repositories (real CLI)", () => {
  let folder: string;
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "metator-system-"));
    const repo = async (name: string, files: Record<string, string>) => {
      const dir = join(folder, name);
      for (const [p, t] of Object.entries(files)) await Bun.write(join(dir, p), t);
      const git = (...a: string[]) =>
        Bun.spawnSync(
          ["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a],
          { cwd: dir },
        );
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
    };
    // The application is the repository's root (its own Dockerfile), with a library package beside it.
    await repo("billing", {
      "package.json": json({
        name: "billing",
        private: true,
        workspaces: ["packages/*"],
        scripts: { start: "bun src/server.ts" },
        dependencies: { "billing-templates": "workspace:*" },
      }),
      Dockerfile: "FROM oven/bun\n",
      "src/server.ts":
        'import { t } from "billing-templates";\nexport const s = t;\nSwaggerModule.setup("docs", app, document);\n',
      "packages/templates/package.json": json({ name: "billing-templates", private: true, main: "index.ts" }),
      "packages/templates/index.ts": "export const t = 1;\n",
      "openapi.yaml": SPEC,
    });
    await repo("web", {
      "package.json": json({
        name: "web",
        private: true,
        scripts: {
          dev: "vite",
          "gen:api": "openapi-typescript ../billing/openapi.yaml",
          "gen:live": "openapi-typescript https://billing.shop.internal/docs-json",
        },
        dependencies: { react: "19" },
      }),
      "src/main.ts": "export const m = 1;\n",
      // A real env file (secrets) is never read, even committed: no evidence comes from it.
      ".env.local": "BILLING_DOCS=https://billing.shop.internal/docs-json\n",
    });
    await repo("notify", {
      "package.json": json({ name: "notify-worker", private: true, scripts: { start: "bun src/index.ts" } }),
      "src/index.ts": "export const n = 1;\n",
    });
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("each repository is an application; the contract and its consumer cross repositories", async () => {
    const r = await metator(["system", "discover"], folder);
    expect(r.code).toBe(0);
    const d = r.json.data as Discovery;
    expect(d.topology).toBe("repos");
    expect(d.proposal.applications.map((a) => [a.id, a.kind, a.source, a.consumes])).toEqual([
      ["billing", "service", { repo: "billing" }, []],
      ["notify", "worker", { repo: "notify" }, []],
      ["web", "frontend", { repo: "web" }, ["billing-api"]],
    ]);
    expect(d.proposal.contracts.map((c) => [c.id, c.owner, c.spec.path])).toEqual([
      ["billing-api", "billing", "openapi.yaml"],
    ]);
    expect(d.evidence).toContainEqual(
      expect.objectContaining({ subject: "consumes:web→billing-api", file: "web/package.json" }),
    );
    // The document billing serves at runtime, and web fetching it: shown, not proposed.
    expect(
      d.evidence.filter((e) => e.subject.includes(" /")).map((e) => [e.subject, e.proposed, e.file]),
    ).toEqual([
      ["served:billing /docs-json", false, "billing/src/server.ts:3"],
      ["consumes:web→billing /docs-json", false, "web/package.json"],
    ]);
    // A folder has no map of its own: --write and --check say so instead of doing nothing.
    for (const flag of ["--write", "--check"]) {
      const r2 = await metator(["system", "discover", flag], folder);
      expect([r2.code, (r2.json.error as { code: string }).code]).toEqual([64, "USAGE"]);
    }
  }, 120_000);
});
