import { ClaimSetDocument, err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerDocsCommands(program: Command, { action, container }: CommandContext): void {
  const docs = program
    .command("docs")
    .description("Documentation: inventory, dead links, claims that drifted from the code");

  docs
    .command("inventory")
    .description("Every Markdown document with lines, last change, age, owners and links")
    .action(action(async () => ({ result: await container().resolve("docsInventory").execute() })));

  docs
    .command("links")
    .description("Relative links in Markdown that point at a missing file, directory or heading")
    .action(
      action(async () => {
        const report = await container().resolve("docsLinks").execute();
        if (report.isOk() && report.value.dead.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${report.value.dead.length} dead link(s)`, {
                hint: "Fix the target or the heading; links are relative to the document (`/x` to the repo root).",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: report };
      }),
    );

  docs
    .command("drift")
    .description(
      "Verified claims (docs/metator/claims.json) checked against the code again; --fix updates moved lines",
    )
    .option("--fix", "rewrite the line of claims whose quote moved", false)
    .action(
      action(async (opts: { fix: boolean }) => {
        const report = await container().resolve("docsDrift").execute({ fix: opts.fix });
        if (report.isErr()) return { result: report };
        const drifted = report.value.results.filter(
          (r) => r.status === "stale" || r.status === "missing-file",
        );
        const moved = report.value.results.filter((r) => r.status === "moved");
        if (drifted.length + (opts.fix ? 0 : moved.length) > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${drifted.length} drifted, ${moved.length} moved`, {
                hint: "A drifted claim is no longer true in the code: fix the doc or the code; `--fix` updates moved lines.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  docs
    .command("claims-schema")
    .description("Print the JSON Schema of the claims file")
    .action(action(async () => ({ result: ok(ClaimSetDocument.jsonSchema("input")) })));
}
