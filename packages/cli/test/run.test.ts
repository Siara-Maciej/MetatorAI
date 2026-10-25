import { describe, expect, test } from "bun:test";
import { run } from "../src/run.ts";

async function invoke(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = [];
  const code = await run(argv, { out: (text) => lines.push(text) });
  expect(lines).toHaveLength(1);
  return { code, json: JSON.parse(lines[0] as string) };
}

describe("metator CLI", () => {
  test("version returns the package version in an envelope", async () => {
    const { code, json } = await invoke("version");
    expect(code).toBe(0);
    expect(json).toEqual({ ok: true, data: { name: "metator-ai", version: "0.0.0" } });
  });

  test("no arguments defaults to help", async () => {
    const { code, json } = await invoke();
    expect(code).toBe(0);
    expect(JSON.stringify(json)).toContain('"name":"version"');
  });

  test("unknown command is a usage error with a hint and exit code 64", async () => {
    const { code, json } = await invoke("frobnicate");
    expect(code).toBe(64);
    expect(json).toEqual({
      ok: false,
      error: {
        code: "USAGE",
        message: "Unknown command: frobnicate",
        hint: "Run `metator help` to list commands.",
      },
    });
  });

  test("the binary prints one JSON line and exits with the envelope's code", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`, "version"], { stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).data.name).toBe("metator-ai");
  });
});
