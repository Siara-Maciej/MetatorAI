import { AgentDocument, err, MetatorError, ok, SkillDocument } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

/** What `meta check-all` runs: every lint and drift check of the knowledge layer (04-commands §I). */
export const CHECK_ALL: readonly (readonly string[])[] = [
  ["rules", "lint"],
  ["rules", "adapters", "--check"],
  ["memory", "check"],
  ["cards", "build", "--check"],
  ["patterns", "scan", "--check"],
  ["adr", "lint"],
  ["memory", "dupes", "--check"],
  ["meta", "agents-lint"],
  ["meta", "skills-lint"],
  ["workflow", "validate"],
  ["generate", "--check"],
];

export function registerAgentCommands(program: Command, { action, container, invoke }: CommandContext): void {
  const meta = program.command("meta").description("Lint the canonical agents, skills and workflows");

  meta
    .command("agents-lint")
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
                hint: "Fix metator/agents/*.md; `metator meta agents-schema` prints the front matter format.",
                details: { ...report.value },
              }),
            ),
            warnings,
          };
        }
        return { result: ok(report.value), warnings };
      }),
    );

  meta
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

  meta
    .command("check-all")
    .description(
      "Every lint and check in one run (pre-commit, CI): rules, memory, cards, patterns, ADRs, agents, skills, workflows, generated files",
    )
    .option("--min-e1 <percent>", "rules coverage floor: percent of rules a tool enforces", positiveInt, 40)
    .action(
      action(async (opts: { minE1: number }) => {
        const root = (program.opts() as { root?: string }).root;
        const prefix = root ? ["--root", root] : [];
        const checks = [];
        for (const argv of [...CHECK_ALL, ["rules", "coverage", "--min-e1", String(opts.minE1)]]) {
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

  meta
    .command("agents-schema")
    .description("Print the JSON Schema of a canonical agent's front matter")
    .action(action(() => ({ result: ok(AgentDocument.jsonSchema("input")) })));

  meta
    .command("skills-lint")
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
                hint: "Fix metator/skills/<name>/SKILL.md; `metator meta skills-schema` prints the front matter format.",
                details: { ...report.value },
              }),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  meta
    .command("skills-schema")
    .description("Print the JSON Schema of a canonical skill's front matter")
    .action(action(() => ({ result: ok(SkillDocument.jsonSchema("input")) })));

  program
    .command("generate")
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
