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
    expect(json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    const error = json.error as { message: string; hint: string };
    expect(error.message).toContain("frobnicate");
    expect(error.hint).toContain("metator help");
  });

  test("the binary prints one JSON line and exits with the envelope's code", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/main.ts`, "version"], { stdout: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).data.name).toBe("metator-ai");
  });
});

describe("metator CLI usage errors (fail before touching the repository)", () => {
  const usage = async (...argv: string[]) => {
    const { code, json } = await invoke(...argv);
    expect(code).toBe(64);
    expect(json).toMatchObject({ ok: false, error: { code: "USAGE" } });
    return (json.error as { message: string }).message;
  };

  test("approve without --by", async () => {
    expect(await usage("run", "advance", "approve")).toContain("--by");
  });

  test("approve with a blank --by", async () => {
    expect(await usage("run", "advance", "approve", "--by", "  ")).toContain("--by");
  });

  test("abort without --reason", async () => {
    expect(await usage("run", "advance", "abort")).toContain("--reason");
  });

  test("unknown event", async () => {
    const message = await usage("run", "advance", "skip");
    expect(message).toContain("'skip'");
    expect(message).toContain("Allowed choices are pass, fail, approve, abort");
  });

  test("invalid autonomy level", async () => {
    const message = await usage("run", "init", "--workflow", "w", "--task", "t", "--autonomy", "L9");
    expect(message).toContain("'L9'");
    expect(message).toContain("Allowed choices are L0, L1, L2");
  });

  test("blank task", async () => {
    expect(await usage("run", "init", "--workflow", "w", "--task", "   ")).toContain("--task");
  });

  test("missing required option", async () => {
    expect(await usage("run", "init", "--task", "t")).toContain("--workflow");
  });

  test("unknown option", async () => {
    expect(await usage("run", "status", "--bogus")).toContain("--bogus");
  });
});
