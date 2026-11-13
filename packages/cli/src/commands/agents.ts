import { AgentDocument, err, MetatorError, ok, SkillDocument } from "@metator/core";
import { Argument, type Command } from "commander";
import { checkCommands, meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt, ratio } from "../options.ts";

export function registerAgentCommands(
  program: Command,
  { action, container, invoke, root: given }: CommandContext,
): void {
  const group = program.command("meta").description("Lint the canonical agents, skills and workflows");

  meta(group.command("agents-lint"), { audience: "ci", check: [] })
    .description("Canonical agents: schema, prefix, delegation (known, allowed, acyclic), sections, size")
    .action(
      action(async () => {
        const report = await container().resolve("lintAgents").execute();
        if (report.isErr()) return { result: report };
        const warnings = report.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.source}: ${p.message}`);
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} agent problem(s)`, {
                hint: "Fix metator/agents/*.md; `metator meta schema agents` prints the front matter format.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );

  group
    .command("audit")
    .description(
      "Inventory of agents, skills and prompts (canonical and in host directories) with their call graph",
    )
    .action(
      action(async () => {
        const audit = await container().resolve("auditAgents").execute();
        if (audit.isErr()) return { result: audit };
        const { cycles, dead, tooDeep, unknownReferences } = audit.value;
        const warnings = [
          ...cycles.map((c) => `call cycle: ${c.join(" → ")}`),
          ...dead.map((d) => `${d}: nothing reaches it from an entry point`),
          ...tooDeep.map((c) => `delegation deeper than 2 levels: ${c.join(" → ")}`),
          ...unknownReferences.map((r) => `${r.from} delegates to unknown ${r.to}`),
        ];
        return { result: ok(audit.value), warnings };
      }),
    );

  meta(group.command("check-all"), { audience: "ci" })
    .description(
      "Every lint and check in one run (pre-commit, CI): rules, memory, cards, patterns, ADRs, agents, skills, workflows, generated files",
    )
    .option("--min-e1 <percent>", "rules coverage floor: percent of rules a tool enforces", positiveInt, 40)
    .action(
      action(async (opts: { minE1: number }) => {
        const root = given();
        const prefix = root ? ["--root", root] : [];
        const checks = [];
        // Every command that says `check` where it is registered, then the coverage floor.
        for (const argv of [
          ...checkCommands(program),
          ["rules", "coverage", "--min-e1", String(opts.minE1)],
        ]) {
          const r = await invoke([...prefix, ...argv]);
          const error = r.envelope.error as { code?: string; message?: string } | undefined;
          checks.push({
            command: argv.join(" "),
            passed: r.code === 0,
            ...(error ? { error: `${error.code}: ${error.message}` } : {}),
          });
        }
        const failed = checks.filter((c) => !c.passed);
        if (failed.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${failed.length} of ${checks.length} checks failed`, {
                hint: "Run each failing command on its own for the details.",
                details: { checks },
              }),
            ),
          };
        }
        return { result: ok({ checks }) };
      }),
    );

  group
    .command("quarterly")
    .description(
      "The quarterly review (F6): rule coverage and dead rules, memory budgets, stale documents, unpromoted lessons, review evals against a baseline; written to .metator/reviews/",
    )
    .option("--stale-days <days>", "a document or lesson untouched this long is stale", positiveInt, 90)
    .option("--baseline <file>", "EvalReport of the baseline (from `metator eval score`)")
    .option("--report <file>", "EvalReport of the current state to compare with the baseline")
    .option("--tolerance <ratio>", "allowed drop per eval number", ratio, 0.02)
    .action(
      action(async (opts: { staleDays: number; baseline?: string; report?: string; tolerance: number }) => {
        const review = await container()
          .resolve("quarterlyReview")
          .execute({
            staleDays: opts.staleDays,
            tolerance: opts.tolerance,
            ...(opts.baseline ? { baseline: opts.baseline } : {}),
            ...(opts.report ? { report: opts.report } : {}),
          });
        if (review.isErr()) return { result: review };
        return { result: ok(review.value), warnings: review.value.actions };
      }),
    );

  // `meta schema agents|skills`, as every other group names its schema; the two old names still run.
  const schemas = { agents: AgentDocument, skills: SkillDocument };
  const schema = group
    .command("schema")
    .description("Print the JSON Schema of a canonical agent's or skill's front matter")
    .addArgument(new Argument("<kind>", "whose front matter").choices(Object.keys(schemas)))
    .action(action((kind: keyof typeof schemas) => ({ result: ok(schemas[kind].jsonSchema("input")) })));
  meta(schema, { renamedFrom: "meta agents-schema" });

  meta(group.command("agents-schema", { hidden: true }), { renamedTo: "meta schema agents" })
    .description("Print the JSON Schema of a canonical agent's front matter")
    .action(action(() => ({ result: ok(AgentDocument.jsonSchema("input")) })));

  meta(group.command("skills-lint"), { audience: "ci", check: [] })
    .description("Canonical skills: name = directory, trigger and anti-trigger, sections, size, files exist")
    .action(
      action(async () => {
        const report = await container().resolve("lintSkills").execute();
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} skill problem(s)`, {
                hint: "Fix metator/skills/<name>/SKILL.md; `metator meta schema skills` prints the front matter format.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  meta(group.command("skills-schema", { hidden: true }), { renamedTo: "meta schema skills" })
    .description("Print the JSON Schema of a canonical skill's front matter")
    .action(action(() => ({ result: ok(SkillDocument.jsonSchema("input")) })));

  meta(program.command("generate"), { audience: "person", check: ["--check"] })
    .description("Host files (Copilot, Claude Code) from the canonical agents and skills")
    .option("--check", "compare only; fail when generated files are stale or orphaned", false)
    .option("--hooks", "also install the hook configuration (`metator guard *`) for each host", false)
    .action(
      action(async (opts: { check: boolean; hooks: boolean }) => {
        const agents = await container()
          .resolve("generateHosts")
          .execute({ check: opts.check, hooks: opts.hooks });
        if (agents.isErr()) return { result: agents };
        const skills = await container().resolve("generateSkills").execute({ check: opts.check });
        if (skills.isErr()) return { result: skills };
        const report = {
          value: {
            written: [...agents.value.written, ...skills.value.written],
            unchanged: [...agents.value.unchanged, ...skills.value.unchanged],
            stale: [...agents.value.stale, ...skills.value.stale],
            orphaned: [...agents.value.orphaned, ...skills.value.orphaned],
          },
        };
        const warnings = report.value.orphaned.map(
          (f) => `${f}: generated from an agent or skill that no longer exists; delete it`,
        );
        if (opts.check && report.value.stale.length + report.value.orphaned.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${report.value.stale.length} stale generated file(s)`, {
                hint: "Run `metator generate` and commit the result; never edit generated host files.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );
}
