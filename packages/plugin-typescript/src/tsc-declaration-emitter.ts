import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeclarationEmitter,
  err,
  MetatorError,
  ok,
  type ProcessRunner,
  type Result,
} from "@metator/core";

/**
 * Declaration files from the TypeScript compiler (ADR-0040): `tsc --declaration
 * --emitDeclarationOnly` into a temporary directory, read back by repo-relative path.
 */
export class TscDeclarationEmitter implements DeclarationEmitter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly root: string,
  ) {}

  async emit(): Promise<Result<ReadonlyMap<string, string>, MetatorError>> {
    if (!existsSync(join(this.root, "tsconfig.json")))
      return err(
        new MetatorError("NOT_FOUND", "tsconfig.json not found", {
          hint: "api snapshot needs a TypeScript project.",
        }),
      );
    const out = await mkdtemp(join(tmpdir(), "metator-dts-"));
    try {
      const local = join(this.root, "node_modules", ".bin", "tsc");
      const argv = [
        existsSync(local) ? local : "tsc",
        "-p",
        "tsconfig.json",
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        out,
      ];
      const r = await this.runner.run({ argv, cwd: this.root }, { timeoutMs: 300_000 });
      if (r.exitCode === 127) return err(new MetatorError("BIN_NOT_FOUND", "tsc is not installed"));
      const files = new Map<string, string>();
      for await (const rel of new Bun.Glob("**/*.d.ts").scan({ cwd: out }))
        files.set(rel, await Bun.file(join(out, rel)).text());
      // Type errors still emit declarations; only a run that produced nothing failed.
      if (files.size === 0)
        return err(
          new MetatorError("COMMAND_FAILED", `tsc emitted no declarations (exit ${r.exitCode})`, {
            details: { output: `${r.stdout}${r.stderr}`.slice(0, 500) },
          }),
        );
      return ok(files);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }
}
