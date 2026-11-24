/**
 * React Compiler (ADR-0109) memoizes what it can compile and skips the rest without a word: a
 * component it skips draws again on every render of its parent. Every file of `src/` is compiled
 * here as the build compiles it, and every component and hook must compile.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";

const SRC = join(import.meta.dir, "../src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );

interface Outcome {
  readonly compiled: number;
  readonly skipped: readonly string[];
}

/** What the compiler did with one source: how many functions it compiled, which it skipped and why. */
export function compile(file: string, code: string): Outcome {
  let compiled = 0;
  const skipped: string[] = [];
  transformSync(code, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        reactCompiler,
        {
          logger: {
            logEvent(
              _: string | null,
              e: { kind: string; fnLoc?: { start?: { line?: number } }; detail?: unknown },
            ) {
              if (e.kind === "CompileSuccess") compiled++;
              else if (e.kind === "CompileError" || e.kind === "PipelineError") {
                const d = e.detail as { reason?: string; options?: { reason?: string } } | undefined;
                skipped.push(
                  `${file}:${e.fnLoc?.start?.line ?? "?"} ${d?.reason ?? d?.options?.reason ?? e.kind}`,
                );
              }
            },
          },
        },
      ],
    ],
  });
  return { compiled, skipped };
}

describe("React Compiler", () => {
  test("compiles every component and hook of the app", () => {
    const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
    let compiled = 0;
    const skipped: string[] = [];
    for (const f of files) {
      const r = compile(relative(SRC, f), readFileSync(f, "utf8"));
      compiled += r.compiled;
      skipped.push(...r.skipped);
    }
    expect(skipped).toEqual([]);
    expect(compiled).toBeGreaterThan(100);
    // Compiling every file of the app takes several seconds.
  }, 60_000);

  test("a component that writes a ref while it renders is skipped, so the check above can fail", () => {
    const code = `import { useRef } from "react";
export function Latest({ value }: { value: number }) {
  const ref = useRef(value);
  ref.current = value;
  return <span>{value}</span>;
}`;
    const r = compile("latest.tsx", code);
    expect(r.compiled).toBe(0);
    expect(r.skipped).toHaveLength(1);
  });
});
