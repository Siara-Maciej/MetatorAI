import { ArchitecturePolicyDocument, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

const DECLARATION_KINDS = new Set([
  "undeclared",
  "root-only",
  "dev-in-prod",
  "unused-dependency",
  "version-drift",
]);

export function registerArchCommands(program: Command, { action, container }: CommandContext): void {
  const arch = program
    .command("arch")
    .description(
      "The architecture of the workspace packages: graph, cycles, policy, metrics, refactor plans",
    );

  arch
    .command("analyze")
    .description("Analyze the package graph; writes .metator/arch/report.json and report.md")
    .action(
      action(async () => {
        const analyzed = await container().resolve("analyzeArchitecture").execute();
        return {
          result: analyzed.map((a) => ({ files: a.files, ...a.report })),
          warnings: analyzed.isOk()
            ? analyzed.value.report.violations
                .filter((v) => !v.exception && v.severity === "error")
                .slice(0, 10)
                .map((v) => v.message)
            : [],
        };
      }),
    );

  arch
    .command("cycles")
    .description("Cycles between packages, with the imports that close them")
    .action(
      action(async () => ({
        result: (await container().resolve("analyzeArchitecture").execute()).map((a) => ({
          cycles: a.report.cycles,
        })),
      })),
    );

  arch
    .command("declared")
    .description("Dependencies imported but not declared, declared but not imported, and version drift")
    .action(
      action(async () => ({
        result: (await container().resolve("analyzeArchitecture").execute()).map((a) => ({
          violations: a.report.violations.filter((v) => DECLARATION_KINDS.has(v.kind)),
        })),
      })),
    );

  arch
    .command("schema")
    .description("Print the JSON Schema of metator/architecture.yml")
    .action(action(async () => ({ result: ok(ArchitecturePolicyDocument.jsonSchema("input")) })));
}
