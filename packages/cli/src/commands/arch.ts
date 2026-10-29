import { ArchitecturePolicyDocument, err, MetatorError, type Move, ok } from "@metator/core";
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

  const simulate = arch
    .command("simulate")
    .description("What a move would fix and break, computed on the graph; no file is touched");
  const run = (move: Move) =>
    container()
      .resolve("simulateArchitecture")
      .execute({ moves: [move] });
  simulate
    .command("move")
    .description("Move files (paths or globs) to another package")
    .argument("<files...>", "repo-relative files or globs")
    .requiredOption("--to <package>", "the package that receives them")
    .action(
      action(async (files: string[], opts: { to: string }) => ({
        result: await run({ type: "move", files, to: opts.to }),
      })),
    );
  simulate
    .command("merge")
    .description("Merge one package into another")
    .argument("<package>", "the package that disappears")
    .requiredOption("--into <package>", "the package that receives its files")
    .action(
      action(async (from: string, opts: { into: string }) => ({
        result: await run({ type: "merge", from, into: opts.into }),
      })),
    );
  simulate
    .command("extract")
    .description("Extract files into a new package")
    .argument("<files...>", "repo-relative files or globs")
    .requiredOption("--name <name>", "the new package's name")
    .requiredOption("--dir <dir>", "the new package's directory")
    .action(
      action(async (files: string[], opts: { name: string; dir: string }) => ({
        result: await run({ type: "extract", files, package: { name: opts.name, dir: opts.dir } }),
      })),
    );
  simulate
    .command("invert")
    .description("Invert a dependency: <from> keeps a port, <to> implements it")
    .argument("<from>", "the package that depends today")
    .argument("<to>", "the package it depends on today")
    .action(
      action(async (from: string, to: string) => ({ result: await run({ type: "invert", from, to }) })),
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
