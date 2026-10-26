import { err, MetatorError, normalizePath, ok } from "@metator/core";
import { Argument, type Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerGateCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("gate")
    .description(
      "Run a gate's steps from metator.config (quick: before every commit, full or all: before a PR)",
    )
    .addArgument(new Argument("<gate>", "which gate (all is full)").choices(["quick", "full", "all"]))
    .option("--files <files...>", "scope file-appending steps to these files")
    .option("--base <ref>", "scope file-appending steps to files changed against this ref")
    .action(
      action(async (name: "quick" | "full" | "all", opts: { files?: string[]; base?: string }) => {
        const gate = name === "all" ? "full" : name;
        const c = container();
        const steps = c.resolve("config").config.gates[gate];
        if (steps.length === 0) {
          return {
            result: err(
              MetatorError.usage(
                `Gate "${gate}" has no steps`,
                "Add gates.quick / gates.full to metator.config (`metator init` proposes them).",
              ),
            ),
          };
        }
        const input = opts.files
          ? { gate, files: opts.files.map((f) => normalizePath(f)) }
          : opts.base
            ? { gate, base: opts.base }
            : { gate };
        const report = await c.resolve("runGate").execute(input);
        if (report.isErr()) return { result: report };
        if (!report.value.passed) {
          const red = report.value.steps
            .filter((s) => s.status === "fail" || s.status === "error")
            .map((s) => s.id);
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `gate ${gate} failed: ${red.join(", ")}`, {
                hint: "Fix the failing steps; each step's detail holds the end of its output.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );
}
