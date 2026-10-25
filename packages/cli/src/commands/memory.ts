import { err, MemoryMapDocument, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerMemoryCommands(program: Command, { action, container }: CommandContext): void {
  const memory = program
    .command("memory")
    .description("Memory map: knowledge inventory, context budgets, citations, CI guard");

  memory
    .command("inventory")
    .description("Every knowledge file with its size and memory map item (works without a map)")
    .action(action(async () => ({ result: await container().resolve("inventoryMemory").execute() })));

  memory
    .command("budget")
    .description("File and tier sizes against the memory map budgets")
    .action(
      action(async () => {
        const report = await container().resolve("memoryBudget").execute();
        if (report.isOk() && report.value.overBudget > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${report.value.overBudget} budget(s) exceeded`, {
                hint: "Shorten the files, move detail to a skill or query, or raise the budget in the memory map.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: report };
      }),
    );

  memory
    .command("validate")
    .description('Check [[cite: path:line | "quote"]] claims; --fix updates lines of moved quotes')
    .option("--fix", "rewrite line numbers of quotes that moved", false)
    .action(
      action(async (opts: { fix: boolean }) => {
        const report = await container().resolve("validateCitations").execute({ fix: opts.fix });
        if (report.isErr()) return { result: report };
        const { stale, moved } = report.value.counts;
        const broken = stale + report.value.counts["missing-file"];
        if (broken + moved > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${broken} stale and ${moved} moved citation(s)`, {
                hint:
                  moved > 0
                    ? "Run `metator memory validate --fix` for moved quotes; re-verify stale claims by hand."
                    : "Re-verify the stale claims against the code and update or remove them.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  memory
    .command("check")
    .description("CI guard: every knowledge file mapped, budgets kept, citations true")
    .action(
      action(async () => {
        const report = await container().resolve("checkMemory").execute();
        if (report.isErr()) return { result: report };
        const warnings = report.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.path ?? p.item ?? "memory map"}: ${p.message}`);
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} memory problem(s)`, {
                hint: "Map new knowledge files in docs/metator/memory-map.yml, keep budgets, fix stale citations.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );

  memory
    .command("schema")
    .description("Print the JSON Schema of the memory map")
    .action(action(() => ({ result: ok(MemoryMapDocument.jsonSchema("input")) })));
}
