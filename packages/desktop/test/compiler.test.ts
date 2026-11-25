/**
 * React Compiler (ADR-0109) memoizes what it can compile and skips the rest without a word: a
 * component it skips draws again on every render of its parent. Every file of `src/` is compiled
 * here as the build compiles it, and every component and hook must compile. The compiler runs in a
 * process of its own (`compile-with-react-compiler.ts`): loading it changes the process's globals.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );

interface Outcome {
  readonly file: string;
  readonly compiled: number;
  readonly skipped: readonly string[];
}

/** What the compiler did with each source: how many functions it compiled, which it skipped and why. */
async function compile(sources: readonly { file: string; code: string }[]): Promise<Outcome[]> {
  const p = Bun.spawn(["bun", join(import.meta.dir, "compile-with-react-compiler.ts")], {
    cwd: join(import.meta.dir, ".."),
    stdin: new Blob([JSON.stringify(sources)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`the compiler failed:\n${err}`);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Outcome);
}

describe("React Compiler", () => {
  test("compiles every component and hook of the app", async () => {
    const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
    const outcomes = await compile(
      files.map((f) => ({ file: relative(SRC, f), code: readFileSync(f, "utf8") })),
    );
    expect(outcomes.flatMap((o) => o.skipped)).toEqual([]);
    expect(outcomes.reduce((n, o) => n + o.compiled, 0)).toBeGreaterThan(100);
    // Compiling every file of the app takes several seconds.
  }, 60_000);

  test("a component that writes a ref while it renders is skipped, so the check above can fail", async () => {
    const code = `import { useRef } from "react";
export function Latest({ value }: { value: number }) {
  const ref = useRef(value);
  ref.current = value;
  return <span>{value}</span>;
}`;
    const [r] = await compile([{ file: "latest.tsx", code }]);
    expect(r?.compiled).toBe(0);
    expect(r?.skipped).toHaveLength(1);
  });
});
