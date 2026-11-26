import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

    test("a timeout also kills what the process started, and does not wait for it to close the output", async () => {
      const started = performance.now();
      // The grandchild holds stdout open; killing only `sh` would leave the read waiting 8 s.
      const r = await make().run({ argv: ["sh", "-c", "sleep 8 & echo $!; wait"], cwd }, { timeoutMs: 500 });
      expect(r.exitCode).toBe(124);
      expect(performance.now() - started).toBeLessThan(3000);
      const pid = Number(r.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      const alive = () => {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        // A killed process nobody reaped yet (a container's init may not) is a zombie: dead.
        const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
        return !/\) Z /.test(stat);
      };
      for (let i = 0; i < 20 && alive(); i++) await Bun.sleep(50);
      expect(alive()).toBe(false);
    });

    test("reports a duration", async () => {
      const r = await make().run({ argv: ["true"], cwd });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
}
