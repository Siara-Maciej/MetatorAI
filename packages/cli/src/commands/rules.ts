import { err, MetatorError, normalizePath, ok, RuleSetDocument } from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt, renamedOption } from "../options.ts";
import { schemaCommand } from "../outcome.ts";

const repoPaths = (files: readonly string[]) => files.map((f) => normalizePath(f).replace(/^(\.\/)+/, ""));

export function registerRulesCommands(program: Command, { action, container }: CommandContext): void {
  const rules = program
    .command("rules")
    .description("Rule canon: lint, pack for agents, host adapters, E1 checks");

  meta(rules.command("lint"), { audience: "ci", reads: true, check: [] })
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

  meta(rules.command("pack"), { reads: true })
    .description(
      "Rules that apply to the given files (default: files changed against --base), sized for an agent",
    )
    .option("--files <files...>", "repo-relative files the agent will touch")
    .addOption(renamedOption("--paths <files...>", "--files"))
    .option("--base <ref>", "use files changed against this git ref", "HEAD")
    .option("--budget <tokens>", "token budget for the pack", positiveInt)
    .action(
      action(async (opts: { files?: string[]; paths?: string[]; base: string; budget?: number }) => {
        const c = container();
        const given = opts.files ?? opts.paths;
        let paths = given ? repoPaths(given) : undefined;
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

  meta(rules.command("show"), { reads: true })
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

  meta(rules.command("adapters"), { audience: "ci", check: ["--check"] })
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

  meta(rules.command("check"), { audience: "person", reads: true })
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

  meta(rules.command("coverage"), { audience: "ci", reads: true })
    .description("Share of rules enforced by tools (E1), and rules missing tests, files or examples")
    .option("--min-e1 <percent>", "fail when fewer active rules than this are E1", positiveInt)
    .action(
      action(async (opts: { minE1?: number }) => {
        const report = await container().resolve("measureRuleCoverage").execute();
        if (report.isErr()) return { result: report };
        if (opts.minE1 !== undefined && report.value.total.e1Percent < opts.minE1) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `E1 coverage ${report.value.total.e1Percent}% < ${opts.minE1}%`,
                {
                  hint: "Turn checkable E2 rules into tool rules: `metator rules scaffold <id>`.",
                  details: { ...report.value },
                },
              ),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  rules
    .command("scaffold")
    .description("Skeleton of a tool rule and its failing test for a canon rule (first step to E1)")
    .argument("<id>", "canon rule id, e.g. MT-ARCH-006")
    .addOption(new Option("--engine <engine>", "rule engine").choices(["ast-grep"]).default("ast-grep"))
    .action(
      action(async (id: string, opts: { engine: string }) => ({
        result: await container().resolve("scaffoldRule").execute({ id, engine: opts.engine }),
      })),
    );

  schemaCommand(rules, { action }, "Print the JSON Schema of a rule set file", RuleSetDocument);
}
