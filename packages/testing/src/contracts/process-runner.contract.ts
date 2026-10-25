import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ProcessRunner } from "@metator/core";

/** Every real ProcessRunner adapter must pass this suite (uses POSIX `sh`). */
export function processRunnerContract(name: string, make: () => ProcessRunner): void {
  describe(`ProcessRunner contract: ${name}`, () => {
    const cwd = tmpdir();

    test("captures stdout, stderr and exit code separately", async () => {
      const r = await make().run({ argv: ["sh", "-c", "echo out; echo err 1>&2; exit 3"], cwd });
      expect([r.stdout, r.stderr, r.exitCode]).toEqual(["out\n", "err\n", 3]);
    });

    test("passes argv verbatim (no shell interpolation of arguments)", async () => {
      const r = await make().run({ argv: ["printf", "%s|", "a b", "$HOME", "`x`"], cwd });
      expect(r.stdout).toBe("a b|$HOME|`x`|");
    });

    test("runs in the given cwd and merges env overrides", async () => {
      const r = await make().run({
        argv: ["sh", "-c", 'pwd; echo "$METATOR_TEST_VAR"'],
        cwd,
        env: { METATOR_TEST_VAR: "42" },
      });
      const [dir, value] = r.stdout.trim().split("\n");
      expect(dir?.endsWith(cwd.split("/").pop() as string)).toBe(true);
      expect(value).toBe("42");
    });

    test("a missing binary is exit code 127, not an exception", async () => {
      const r = await make().run({ argv: ["metator-definitely-missing-binary"], cwd });
      expect(r.exitCode).toBe(127);
    });

    test("a timeout kills the process and reports exit code 124", async () => {
      const started = performance.now();
      const r = await make().run({ argv: ["sleep", "5"], cwd }, { timeoutMs: 200 });
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toContain("timed out");
      expect(performance.now() - started).toBeLessThan(3000);
    });

    test("reports a duration", async () => {
      const r = await make().run({ argv: ["true"], cwd });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
}
