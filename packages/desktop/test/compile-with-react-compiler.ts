/**
 * React Compiler over sources, in a process of its own: loading the compiler changes globals of the
 * process (it broke `wait-on` in the tests that ran after it), so `compiler.test.ts` runs this and
 * reads its answer. Input on stdin: `[{ "file": "...", "code": "..." }]`. Output on stdout: one JSON
 * line per file, `{ file, compiled, skipped }`.
 */
import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";

const sources = JSON.parse(await Bun.stdin.text()) as { file: string; code: string }[];
for (const { file, code } of sources) {
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
  console.log(JSON.stringify({ file, compiled, skipped }));
}
