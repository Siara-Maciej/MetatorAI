import { accessMatrix, MemoryMapDocument } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt, ratio } from "../options.ts";
import { failWhen, schemaCommand } from "../outcome.ts";

export function registerMemoryCommands(program: Command, { action, container }: CommandContext): void {
  const memory = program
    .command("memory")
    .description("Memory map: knowledge inventory, context budgets, citations, CI guard");

  meta(memory.command("inventory"), { reads: true })
    .description("Every knowledge file with its size and memory map item (works without a map)")
    .option("--generated", "include the host files `metator generate` wrote (copies of the canon)", false)
    .action(
      action(async (opts: { generated: boolean }) => ({
        result: await container().resolve("inventoryMemory").execute({ generated: opts.generated }),
      })),
    );

  meta(memory.command("budget"), { reads: true })
    .description("File and tier sizes against the memory map budgets")
    .action(
      action(async () =>
        failWhen(
          await container().resolve("memoryBudget").execute(),
          (r) =>
            r.overBudget > 0 && {
              message: `${r.overBudget} budget(s) exceeded`,
              hint: "Shorten the files, move detail to a skill or query, or raise the budget in the memory map.",
            },
        ),
      ),
    );

  meta(memory.command("validate"), { reads: true, writesWith: ["--fix"] })
    .description('Check [[cite: path:line | "quote"]] claims; --fix updates lines of moved quotes')
    .option("--fix", "rewrite line numbers of quotes that moved", false)
    .action(
      action(async (opts: { fix: boolean }) => {
        return failWhen(await container().resolve("validateCitations").execute({ fix: opts.fix }), (r) => {
          const { stale, moved } = r.counts;
          const broken = stale + r.counts["missing-file"];
          return (
            broken + moved > 0 && {
              message: `${broken} stale and ${moved} moved citation(s)`,
              hint:
                moved > 0
                  ? "Run `metator memory validate --fix` for moved quotes; re-verify stale claims by hand."
                  : "Re-verify the stale claims against the code and update or remove them.",
            }
          );
        });
      }),
    );

  meta(memory.command("check"), { audience: "ci", reads: true, check: [] })
    .description("CI guard: every knowledge file mapped, budgets kept, citations true")
    .action(
      action(async () => {
        return failWhen(
          await container().resolve("checkMemory").execute(),
          (r) => {
            const errors = r.problems.filter((p) => p.severity === "error").length;
            return (
              errors > 0 && {
                message: `${errors} memory problem(s)`,
                hint: "Map new knowledge files in docs/metator/memory-map.yml, keep budgets, fix stale citations.",
              }
            );
          },
          (r) =>
            r.problems
              .filter((p) => p.severity === "warning")
              .map((p) => `${p.path ?? p.item ?? "memory map"}: ${p.message}`),
        );
      }),
    );

  meta(memory.command("dupes"), { audience: "ci", reads: true, check: ["--check"] })
    .description("The same statement in several knowledge files (generated copies excluded)")
    .option("--min-words <n>", "shortest sentence that counts", positiveInt, 8)
    .option("--threshold <ratio>", "similarity for near duplicates (Jaccard on word 3-grams)", ratio, 0.8)
    .option("--check", "fail when duplicates exist", false)
    .option("--generated", "include the host files `metator generate` wrote (copies of the canon)", false)
    .action(
      action(async (opts: { minWords: number; threshold: number; check: boolean; generated: boolean }) => {
        return failWhen(
          await container()
            .resolve("findMemoryDupes")
            .execute({ minWords: opts.minWords, threshold: opts.threshold, generated: opts.generated }),
          (r) =>
            opts.check &&
            r.groups.length > 0 && {
              message: `${r.groups.length} duplicated statement(s)`,
              hint: "Keep each statement in one canon file (`keep`) and link to it from the others.",
            },
        );
      }),
    );

  meta(memory.command("matrix"), { reads: true })
    .description("Who reads and writes which memory, from the map's readers and writers")
    .action(
      action(async () => ({
        result: (await container().resolve("memoryMapReader").load()).map(({ map }) => accessMatrix(map)),
      })),
    );

  schemaCommand(memory, { action }, "Print the JSON Schema of the memory map", MemoryMapDocument);
}
