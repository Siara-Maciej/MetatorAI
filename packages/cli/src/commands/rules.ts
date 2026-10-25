import { err, MetatorError, normalizePath, ok, RuleSetDocument } from "@metator/core";
import { type Command, InvalidArgumentError } from "commander";
import type { CommandContext } from "../context.ts";

const repoPaths = (files: readonly string[]) => files.map((f) => normalizePath(f).replace(/^(\.\/)+/, ""));

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

export function registerRulesCommands(program: Command, { action, container }: CommandContext): void {
  const rules = program
    .command("rules")
    .description("Rule canon: lint, pack for agents, host adapters, E1 checks");

  rules
    .command("lint")
    .description("Validate the rule canon (schema, ids, links, E1 implementations and tests)")
    .action(
      action(async () => {
        const report = await container().resolve("lintRules").execute();
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error");
        const warnings = report.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.source}${p.ruleId ? ` ${p.ruleId}` : ""}: ${p.message}`);
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} rule canon problem(s)`, {
                hint: "Fix the listed problems in docs/metator/rules/*.yml.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );

  rules
    .command("pack")
    .description(
      "Rules that apply to the given paths (default: files changed against --base), sized for an agent",
    )
    .option("--paths <files...>", "repo-relative paths the agent will touch")
    .option("--base <ref>", "use files changed against this git ref", "HEAD")
    .option("--budget <tokens>", "token budget for the pack", positiveInt)
    .action(
      action(async (opts: { paths?: string[]; base: string; budget?: number }) => {
        const c = container();
        let paths = opts.paths ? repoPaths(opts.paths) : undefined;
        if (!paths) {
          const changed = await c.resolve("vcs").changedFiles(opts.base);
          if (changed.isErr()) return { result: changed };
          paths = [...changed.value];
        }
        const pack = await c
          .resolve("packRules")
          .execute(opts.budget === undefined ? { paths } : { paths, budgetTokens: opts.budget });
        return { result: pack };
      }),
    );

  rules
    .command("show")
    .description("One rule from the canon, in full")
    .argument("<id>", "rule id, e.g. MT-ARCH-001")
    .action(
      action(async (id: string) => ({
        result: (await container().resolve("ruleCatalog").get(id)).map(({ rule, area, source }) => ({
          ...rule,
          area,
          source: { file: source, ...rule.source },
        })),
      })),
    );

  rules
    .command("adapters")
    .description("Generate host instruction files (.github/instructions) from the canon")
    .option("--check", "compare only; fail when generated files are stale", false)
    .action(
      action(async (opts: { check: boolean }) => {
        const report = await container().resolve("generateRuleAdapters").execute({ check: opts.check });
        if (report.isErr()) return { result: report };
        const warnings = report.value.orphaned.map(
          (f) => `${f}: generated for a rule set that no longer exists; delete it`,
        );
        if (opts.check && report.value.stale.length + report.value.orphaned.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${report.value.stale.length} stale instruction file(s)`, {
                hint: "Run `metator rules adapters` and commit the result; never edit generated files by hand.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );

  rules
    .command("check")
    .description("Run E1 rule engines (ast-grep) and map findings to canon rule ids")
    .option("--files <files...>", "repo-relative files to check (default: whole repository)")
    .option("--base <ref>", "check only files changed against this git ref")
    .action(
      action(async (opts: { files?: string[]; base?: string }) => {
        const input = opts.files ? { files: repoPaths(opts.files) } : opts.base ? { base: opts.base } : {};
        const report = await container().resolve("checkRules").execute(input);
        if (report.isErr()) return { result: report };
        const errors = report.value.violations.filter((v) => v.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} rule violation(s)`, {
                hint: "Fix the code; `metator rules show <id>` explains a canon rule.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  rules
    .command("schema")
    .description("Print the JSON Schema of a rule set file")
    .action(action(() => ({ result: ok(RuleSetDocument.jsonSchema("input")) })));
}
