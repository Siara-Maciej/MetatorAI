import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import { Discover } from "../src/application/discover.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { SourceFiles } from "../src/application/source-files.ts";
import { classifyScript, codeHostOf, commandsOf } from "../src/domain/discovery.ts";
import { ok } from "../src/domain/result.ts";

const caps = (name: string, command: string) =>
  classifyScript(name, command, "package.json").map(
    (c) => `${c.capability}:${c.confidence}:${c.fileScopable ? "files" : "whole"}`,
  );

describe("classifyScript", () => {
  test.each<[string, string, string[]]>([
    ["lint", "eslint src", ["lint:0.95:whole"]],
    ["lint", "eslint", ["lint:0.95:files"]],
    ["lint", "biome check .", ["lint:0.95:whole"]],
    ["format", "biome check --write .", ["format:0.95:whole"]],
    ["fmt", "prettier --write", ["format:0.95:files"]],
    ["typecheck", "tsc -p tsconfig.json", ["typecheck:0.95:whole"]],
    ["check", "tsc --noEmit", ["typecheck:0.75:whole", "lint:0.6:whole"]],
    ["build", "tsc -b", ["build:0.95:whole"]],
    ["test", "vitest run", ["test:0.95:files"]],
    ["test:e2e", "bun test e2e", ["e2e:0.6:whole"]],
    ["e2e", "playwright test", ["e2e:0.95:files"]],
    ["postinstall", "husky", []],
    ["lint", "eslint --cache", ["lint:0.95:files"]],
    ["lint", "biome lint", ["lint:0.95:files"]],
    // Task runners: the task names what the script does.
    ["lint", "turbo lint", ["lint:0.95:whole"]],
    ["test", "turbo run test:ui test:utils --parallel", ["test:0.95:whole"]],
    ["test", "nx run-many -t test lint", ["test:0.95:whole"]],
    ["verify", "nx affected --targets=lint,test", ["lint:0.75:whole", "test:0.75:whole"]],
    ["test", "lerna run test", ["test:0.95:whole"]],
    // A fixer is the last choice for a check.
    ["lint-staged:eslint", "eslint --fix", ["lint:0.3:whole"]],
    ["lint", "biome check --write .", ["lint:0.3:whole"]],
    // Environment assignments are not the command.
    ["test:utils", "TS_JEST_DEBUG=true jest --coverage", ["test:0.75:files"]],
  ])("%s: %s", (name, command, expected) => {
    expect(caps(name, command)).toEqual(expected);
  });

  test("composite scripts are split and never file-scopable", () => {
    expect(commandsOf("biome check . && tsc --noEmit; run-p lint:* | tee x")).toEqual([
      ["biome", "check", "."],
      ["tsc", "--noEmit"],
      ["run-p", "lint:*"],
      ["tee", "x"],
    ]);
    expect(commandsOf("CI=1 NODE_ENV=test jest && A=b")).toEqual([["jest"]]);
    const [lint] = classifyScript("lint", "eslint --cache && stylelint", "p");
    expect([lint?.fileScopable, lint?.reason]).toEqual([false, "composite script (2 commands)"]);
  });
});

describe("codeHostOf", () => {
  test.each<[string, ReturnType<typeof codeHostOf>]>([
    ["git@github.com:o/r.git", "github"],
    ["https://github.com/o/r", "github"],
    ["https://dev.azure.com/org/p/_git/r", "azure-devops"],
    ["https://org.visualstudio.com/p/_git/r", "azure-devops"],
    ["git@gitlab.example.com:o/r.git", "gitlab"],
    ["ssh://git.internal/r.git", "other"],
  ])("%s → %s", (remote, kind) => {
    expect(codeHostOf(remote)).toBe(kind);
  });
});

describe("Discover", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "acme",
      scripts: { "//": "comments are not scripts", "// lint": "x", lint: "eslint .", test: "vitest run" },
      devDependencies: { eslint: "9", vitest: "3" },
    }),
    "packages/a/package.json": JSON.stringify({ name: "@acme/a", scripts: { build: "tsup" } }),
    "eslint.config.js": "export default [];",
    ".github/workflows/ci.yml": "on: push",
    ".github/copilot-instructions.md": "# x",
    "AGENTS.md": "# x",
    "docs/adr/0001-x.md": "# ADR-0001: x",
    ".github/CODEOWNERS": "* @team",
  };

  function discover(pm: { name: string; lockfiles: string[] } | undefined, remote?: string) {
    const fs = new InMemoryFileSystem(FILES);
    const vcs = new FakeVcs(Object.keys(FILES), [], remote);
    const workspace = { packages: async () => ok([{ name: "@acme/a", dir: "packages/a" }]) };
    const detector = { detect: async () => ok(pm) };
    return {
      fs,
      discover: new Discover(fs, new SourceFiles(vcs, fs, []), vcs, workspace, detector, DEFAULT_PATHS),
    };
  }

  test("facts with evidence, root package included, versioned file written", async () => {
    const w = discover({ name: "pnpm", lockfiles: ["pnpm-lock.yaml"] }, "git@github.com:acme/shop.git");
    const d = (await w.discover.execute())._unsafeUnwrap();
    expect(d.packageManager).toEqual({ name: "pnpm", lockfiles: ["pnpm-lock.yaml"] });
    expect(d.scripts.map((s) => [s.dir, s.name, s.candidates[0]?.capability])).toEqual([
      [".", "lint", "lint"],
      [".", "test", "test"],
      ["packages/a", "build", "build"],
    ]);
    expect(d.scripts[0]?.candidates[0]?.evidence).toEqual(["package.json#scripts.lint"]);
    expect(d.tools).toEqual([
      { id: "eslint", evidence: ["eslint.config.js", "package.json#devDependencies.eslint"] },
      { id: "vitest", evidence: ["package.json#devDependencies.vitest"] },
    ]);
    expect(d.ci).toEqual([{ kind: "github-actions", files: [".github/workflows/ci.yml"] }]);
    expect(d.codeHost).toEqual({ kind: "github", remote: "git@github.com:acme/shop.git" });
    expect(d.docs).toEqual({ adr: "docs/adr", codeowners: ".github/CODEOWNERS" });
    expect(d.ai.map((a) => a.host)).toEqual(["copilot", "agents-md"]);
    const saved = JSON.parse((await w.fs.read(".metator/discovery.json"))._unsafeUnwrap());
    expect([saved.kind, saved.schemaVersion]).toEqual(["Discovery", 1]);
  });

  test("several lockfiles are a warning; no remote and no package manager are null", async () => {
    const d = (
      await discover({ name: "npm", lockfiles: ["package-lock.json", "yarn.lock"] }).discover.execute()
    )._unsafeUnwrap();
    expect(d.warnings).toEqual(["several lockfiles (package-lock.json, yarn.lock): keep the one of npm"]);
    expect(d.codeHost).toBeNull();
    expect((await discover(undefined).discover.execute())._unsafeUnwrap().packageManager).toBeNull();
  });
});
