/**
 * MT-ARCH-009: the repository has no import cycle, type-only imports included. Lint and the type
 * checker accept such a cycle, so `bun run arch` runs this same check (`graph cycles --check`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, read } from "./lib.ts";

async function cycles(root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ["bun", join(ROOT, "packages/cli/src/main.ts"), "graph", "cycles", "--check", "--root", root],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

describe("MT-ARCH-009", () => {
  test("the repository has no import cycle", async () => {
    const r = await cycles(ROOT);
    expect([r.code, JSON.parse(r.out).data]).toEqual([0, { cycles: [] }]);
  }, 60_000);

  test("`bun run arch` runs the check", async () => {
    const scripts = (JSON.parse(await read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.arch).toContain("graph cycles --check");
    expect(scripts.check).toContain("bun run arch");
  });

  test("rejects a cycle made of a type-only import, and prints it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt-arch-009-"));
    try {
      await Bun.write(join(dir, "package.json"), '{ "name": "x" }\n');
      await Bun.write(
        join(dir, "src/a.ts"),
        'import type { B } from "./b.ts";\nexport const a = (b: B) => b;\n',
      );
      await Bun.write(
        join(dir, "src/b.ts"),
        'import { a } from "./a.ts";\nexport interface B { n: number }\nexport const b = a({ n: 1 });\n',
      );
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      const r = await cycles(dir);
      const error = JSON.parse(r.out).error as { code: string; message: string };
      expect([r.code, error.code, error.message]).toEqual([
        1,
        "CHECK_FAILED",
        "1 import cycle(s): src/a.ts ↔ src/b.ts",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
