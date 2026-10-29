import { ArchitecturePolicyDocument, err, MetatorError, ok } from "@metator/core";
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
    .command("init")
    .description(
      "Propose metator/architecture.yml from the packages, Nx and Turborepo boundaries; never overwrites",
    )
    .action(action(async () => ({ result: await container().resolve("initArchitecturePolicy").execute() })));

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
    .command("check")
    .description("Fail on violations the change adds: not at the base, not in the baseline, not excepted")
    .option("--base <ref>", "compare against the merge base with this ref")
    .option("--strict", "new warnings fail too", false)
    .option("--sarif <file>", "also write the new violations as SARIF 2.1.0 (code scanning)")
    .action(
      action(async (opts: { base?: string; strict: boolean; sarif?: string }) => {
        const r = await container()
          .resolve("checkArchitecture")
          .execute({
            ...(opts.base ? { base: opts.base } : {}),
            ...(opts.strict ? { strict: true } : {}),
            ...(opts.sarif ? { sarif: opts.sarif } : {}),
          });
        if (r.isErr() || r.value.failing.length === 0)
          return {
            result: r,
            warnings: r.isOk() ? r.value.added.map((v) => `${v.id}: ${v.message}`) : [],
          };
        return {
          result: err(
            new MetatorError("CHECK_FAILED", `${r.value.failing.length} new architecture violation(s)`, {
              hint: "Fix them, add an exception with a reason and an expiry to metator/architecture.yml, or accept them with `metator arch baseline`.",
              details: { ...r.value },
            }),
          ),
        };
      }),
    );

  arch
    .command("baseline")
    .description(
      "Accept the current violations in metator/arch-baseline.json (--tighten only drops fixed ones)",
    )
    .option("--tighten", "keep only baseline entries that still occur; never accept new ones", false)
    .action(
      action(async (opts: { tighten: boolean }) => ({
        result: await container()
          .resolve("recordArchitectureBaseline")
          .execute(opts.tighten ? { tighten: true } : {}),
      })),
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
