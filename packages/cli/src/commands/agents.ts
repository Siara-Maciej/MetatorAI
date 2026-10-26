import { AgentDocument, err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerAgentCommands(program: Command, { action, container }: CommandContext): void {
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
    .command("agents-schema")
    .description("Print the JSON Schema of a canonical agent's front matter")
    .action(action(() => ({ result: ok(AgentDocument.jsonSchema("input")) })));

  program
    .command("generate")
    .description("Host files (Copilot, Claude Code) from the canonical agents")
    .option("--check", "compare only; fail when generated files are stale or orphaned", false)
    .action(
      action(async (opts: { check: boolean }) => {
        const report = await container().resolve("generateHosts").execute({ check: opts.check });
        if (report.isErr()) return { result: report };
        const warnings = report.value.orphaned.map(
          (f) => `${f}: generated from an agent that no longer exists; delete it`,
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
