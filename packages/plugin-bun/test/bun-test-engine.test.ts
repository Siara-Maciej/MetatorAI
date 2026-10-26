import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedProcessRunner } from "@metator/testing";
import { BunProcessRunner } from "../src/bun-process-runner.ts";
import { BunTestEngine } from "../src/bun-test-engine.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const PASSING = `import { expect, test } from "bun:test";
test("every file is fine", () => expect([]).toEqual([]));
test("rejects a broken file", () => expect(["bad"]).not.toEqual([]));
`;
const FAILING = `import { expect, test } from "bun:test";
test("every command has an e2e test", () => expect(["graph cycles"]).toEqual([]));
`;

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-conformance-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  return dir;
}

describe("BunTestEngine.rules", () => {
  test("lists conformance tests; only those with a rejects case count as tested", async () => {
    const root = await project({
      "rules/conformance/mt-a.test.ts": PASSING,
      "rules/conformance/mt-b.test.ts": FAILING,
      "rules/conformance/helper.ts": "export const x = 1;\n",
    });
    const rules = (await new BunTestEngine(new BunProcessRunner(), root).rules())._unsafeUnwrap();
    expect(rules).toEqual([
      { id: "mt-a", source: "rules/conformance/mt-a.test.ts", hasTest: true },
      { id: "mt-b", source: "rules/conformance/mt-b.test.ts", hasTest: false },
    ]);
  });

  test("a repo without the directory has no rules", async () => {
    const root = await project({ "README.md": "# x\n" });
    expect((await new BunTestEngine(new BunProcessRunner(), root).rules())._unsafeUnwrap()).toEqual([]);
  });

  test("the directory is configurable", async () => {
    const root = await project({ "checks/mt-c.test.ts": PASSING });
    const engine = new BunTestEngine(new BunProcessRunner(), root, "checks");
    expect((await engine.rules())._unsafeUnwrap().map((r) => r.source)).toEqual(["checks/mt-c.test.ts"]);
  });
});

describe("BunTestEngine.check (real bun test)", () => {
  test("a failing conformance test is one error naming what failed", async () => {
    const root = await project({
      "rules/conformance/mt-a.test.ts": PASSING,
      "rules/conformance/mt-b.test.ts": FAILING,
    });
    const diagnostics = (await new BunTestEngine(new BunProcessRunner(), root).check())._unsafeUnwrap();
    expect(diagnostics.map(({ toolRuleId, file, severity }) => ({ toolRuleId, file, severity }))).toEqual([
      { toolRuleId: "mt-b", file: "rules/conformance/mt-b.test.ts", severity: "error" },
    ]);
    expect(diagnostics[0]?.message).toContain("(fail) every command has an e2e test");
    expect(diagnostics[0]?.message).toContain("graph cycles");
  });

  test("passing conformance tests report nothing", async () => {
    const root = await project({ "rules/conformance/mt-a.test.ts": PASSING });
    expect((await new BunTestEngine(new BunProcessRunner(), root).check())._unsafeUnwrap()).toEqual([]);
  });

  test("a missing bun is an error value", async () => {
    const root = await project({ "rules/conformance/mt-a.test.ts": PASSING });
    const runner = new ScriptedProcessRunner(); // unscripted commands exit 127
    const result = await new BunTestEngine(runner, root).check();
    expect(result._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
  });
});
