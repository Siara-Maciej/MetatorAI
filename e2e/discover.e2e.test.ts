/** `metator discover` end to end: real repositories with real lockfiles, git remotes and tools. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMonorepo } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

let mono: ScratchRepo;
let npm: ScratchRepo;

beforeAll(async () => {
  mono = await ScratchRepo.create();
  await createMonorepo(mono.root);
  await mono.commit("init");
  await mono.git("remote", "add", "origin", "https://dev.azure.com/acme/shop/_git/web");

  npm = await ScratchRepo.create();
  await npm.write(
    "package.json",
    JSON.stringify({
      name: "legacy",
      scripts: {
        lint: "eslint src",
        "lint:fix": "eslint --fix",
        test: "jest",
        ci: "npm run lint && npm test",
      },
      devDependencies: { eslint: "9.0.0", jest: "29.0.0" },
    }),
  );
  await npm.write("package-lock.json", "{}");
  await npm.write("yarn.lock", "");
  await npm.write("eslint.config.js", "export default [];\n");
  await npm.write(".github/copilot-instructions.md", "# Instructions\n");
  await npm.commit("init");
}, 60_000);

afterAll(async () => {
  await mono.dispose();
  await npm.dispose();
});

describe("metator discover", () => {
  test("Bun monorepo: package manager, workspaces, code host, versioned output", async () => {
    const r = await metator(["discover"], mono.root);
    expect(r.code).toBe(0);
    expect(data(r).packageManager).toEqual({ name: "bun", lockfiles: ["bun.lock"] });
    expect((data(r).workspaces as Data[]).map((w) => w.name)).toEqual([
      "@acme/web",
      "@acme/billing",
      "@acme/money",
    ]);
    expect(data(r).codeHost).toEqual({
      kind: "azure-devops",
      remote: "https://dev.azure.com/acme/shop/_git/web",
    });
    expect((await findUnversioned(mono.root, [".metator"])).unversioned).toEqual([]);
  });

  test("npm repo: scripts classified with file scope, tools with evidence, lockfile conflict warned", async () => {
    const r = await metator(["discover"], npm.root);
    expect(data(r).packageManager).toMatchObject({ lockfiles: ["package-lock.json", "yarn.lock"] });
    expect(r.json.warnings).toEqual([
      expect.stringContaining("several lockfiles (package-lock.json, yarn.lock)"),
    ]);
    const scripts = Object.fromEntries(
      (data(r).scripts as { name: string; candidates: Data[] }[]).map((s) => [s.name, s.candidates[0]]),
    );
    expect(scripts.lint).toMatchObject({ capability: "lint", fileScopable: false });
    // A fixer is never a check: it rewrites the files it is given.
    expect(scripts["lint:fix"]).toMatchObject({ capability: "lint", confidence: 0.3, fileScopable: false });
    expect(scripts.test).toMatchObject({ capability: "test", fileScopable: true });
    expect(scripts.ci).toBeUndefined(); // composite of script calls: nothing to classify
    expect((data(r).tools as Data[]).map((t) => t.id)).toEqual(["eslint", "jest"]);
    expect(data(r).ai).toEqual([{ host: "copilot", files: [".github/copilot-instructions.md"] }]);
    expect(data(r).codeHost).toBeNull();
  });

  test("dogfood: MetatorAI is a Bun workspace on GitHub with Biome, tsc, ast-grep", async () => {
    const r = await metator(["discover", "--root", SELF], SELF);
    expect(data(r).packageManager).toMatchObject({ name: "bun" });
    expect((data(r).tools as Data[]).map((t) => t.id)).toEqual(
      expect.arrayContaining(["biome", "typescript", "ast-grep"]),
    );
    expect(data(r).docs).toMatchObject({ adr: "docs/adr" });
  });
});
