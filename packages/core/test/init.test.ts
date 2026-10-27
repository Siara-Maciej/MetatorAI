import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { parse } from "yaml";
import { InitProject } from "../src/application/init.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { classifyScript, type Discovery } from "../src/domain/discovery.ts";
import { proposeConfig } from "../src/domain/proposal.ts";
import { ok } from "../src/domain/result.ts";

const discovery = (scripts: Record<string, string>, tools: string[] = []): Discovery => ({
  packageManager: { name: "npm", lockfiles: ["package-lock.json"] },
  workspaces: [],
  scripts: Object.entries(scripts).map(([name, command]) => ({
    package: "app",
    dir: ".",
    name,
    command,
    candidates: classifyScript(name, command, `package.json#scripts.${name}`).map((c) => ({
      ...c,
      evidence: [...c.evidence],
    })),
  })),
  tools: tools.map((id) => ({ id, evidence: [`${id}.json`] })),
  ci: [],
  codeHost: null,
  docs: { adr: null, codeowners: null },
  ai: [],
  warnings: [],
});

const ids = (steps: readonly { id: string; run: unknown; files: string }[]) =>
  steps.map((s) => `${s.id}:${JSON.stringify(s.run)}:${s.files}`);

describe("proposeConfig", () => {
  test("file-scopable lint goes to quick with files; every found capability goes to full", () => {
    const p = proposeConfig(
      discovery({ lint: "eslint", typecheck: "tsc --noEmit", test: "vitest run", e2e: "playwright test" }),
      { ruleCanon: false },
    );
    expect(ids(p.gates.quick)).toEqual(['lint:{"script":"lint"}:append']);
    expect(ids(p.gates.full)).toEqual([
      'lint:{"script":"lint"}:none',
      'typecheck:{"script":"typecheck"}:none',
      'test:{"script":"test"}:none',
      'e2e:{"script":"e2e"}:none',
    ]);
    expect(p.decisions[0]?.evidence).toEqual(["package.json#scripts.lint"]);
  });

  test("a whole-project lint script gets a per-file tool in quick, with the tool's evidence", () => {
    const p = proposeConfig(discovery({ lint: "biome check ." }, ["biome"]), { ruleCanon: false });
    expect(p.gates.quick[0]?.run).toEqual({
      bin: "biome",
      args: ["check", "--files-ignore-unknown=true", "--no-errors-on-unmatched"],
    });
    expect(p.decisions.find((d) => d.gate === "quick")?.evidence).toEqual([
      "biome.json",
      "package.json#scripts.lint",
    ]);
  });

  test("no per-file tool means no quick lint; a rule canon adds the rules step to both gates", () => {
    const p = proposeConfig(discovery({ lint: "stylelint ." }), { ruleCanon: true });
    expect(ids(p.gates.quick)).toEqual(['rules:{"metator":"rules check"}:none']);
    expect(p.gates.full.map((s) => s.id)).toEqual(["lint", "rules"]); // the script still runs in full
  });

  test("the same discovery always gives the same proposal", () => {
    const d = discovery({ lint: "eslint", test: "jest" }, ["eslint"]);
    expect(proposeConfig(d, { ruleCanon: true })).toEqual(proposeConfig(d, { ruleCanon: true }));
  });
});

describe("InitProject", () => {
  const disc = { execute: async () => ok(discovery({ lint: "eslint src", test: "vitest run" }, ["eslint"])) };

  test("writes a short config that parses back as MetatorConfig v1", async () => {
    const fs = new InMemoryFileSystem({});
    const report = (
      await new InitProject(disc, fs, DEFAULT_PATHS).execute({ dryRun: false })
    )._unsafeUnwrap();
    expect(report.written).toBe("metator.config.yml");
    const text = (await fs.read("metator.config.yml"))._unsafeUnwrap();
    expect(text).not.toContain("okExitCodes");
    const config = MetatorConfigDocument.parse(parse(text), "metator.config.yml")._unsafeUnwrap();
    expect(config.gates.quick.map((s) => s.id)).toEqual(["lint"]);
    expect(config.gates.full.map((s) => s.id)).toEqual(["lint", "test"]);
  });

  test("chosen hosts are written; without a choice the file keeps the default (every host)", async () => {
    const targets = async (hosts?: ("claude" | "copilot")[]) => {
      const fs = new InMemoryFileSystem({});
      await new InitProject(disc, fs, DEFAULT_PATHS).execute({ dryRun: false, ...(hosts ? { hosts } : {}) });
      const text = (await fs.read("metator.config.yml"))._unsafeUnwrap();
      return [
        text.includes("hosts:"),
        MetatorConfigDocument.parse(parse(text), "c")._unsafeUnwrap().hosts.targets,
      ];
    };
    expect(await targets(["claude"])).toEqual([true, ["claude"]]);
    expect(await targets()).toEqual([false, ["copilot", "claude"]]);
  });

  test("never overwrites; a dry run always works and writes nothing", async () => {
    const fs = new InMemoryFileSystem({ "metator.config.json": "{}" });
    const init = new InitProject(disc, fs, DEFAULT_PATHS);
    expect((await init.execute({ dryRun: false }))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await init.execute({ dryRun: true }))._unsafeUnwrap().written).toBeNull();
    expect(await fs.exists("metator.config.yml")).toBe(false);
  });

  test("warns when nothing can run in the quick gate", async () => {
    const bare = { execute: async () => ok(discovery({ test: "vitest run" })) };
    const report = (
      await new InitProject(bare, new InMemoryFileSystem({}), DEFAULT_PATHS).execute({ dryRun: true })
    )._unsafeUnwrap();
    expect(report.warnings).toEqual(["no file-scoped checks found for the quick gate; add one by hand"]);
  });
});

describe("proposeConfig picks the strongest signal", () => {
  test("of two lint scripts, the one that also runs a linter wins over a name-only match", () => {
    const p = proposeConfig(discovery({ "lint:fix": "node fix.js", lint: "eslint" }), { ruleCanon: false });
    expect(p.gates.full.map((s) => JSON.stringify(s.run))).toEqual(['{"script":"lint"}']);
  });
});
