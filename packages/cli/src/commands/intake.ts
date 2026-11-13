import { err, ok } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { resume } from "../sessions.ts";

/**
 * `metator intake` (T2, design/14 §3): the rules that turn items of GitHub, GitLab or Jira
 * (read through the configured MCP servers) into issues of the backlog and runs. The daemon
 * scans on its own (`serve --intake-ms`); `scan` does one pass by hand.
 */
export function registerIntakeCommands(program: Command, { action, container }: CommandContext): void {
  const intake = program
    .command("intake")
    .description("Automatic intake: outside issues become tasks and runs under the rules of metator.config");

  intake
    .command("rules")
    .description("The intake rules of this repository: source, filter, workflow, autonomy")
    .action(
      action(async () => {
        const { everyMs, maxActive, rules } = container().resolve("config").config.intake;
        return { result: ok({ everyMs, maxActive, rules }) };
      }),
    );

  meta(intake.command("scan"), { audience: "person" })
    .description("One pass over every rule: new items become issues and runs (at most `maxActive` at once)")
    .option("--dry-run", "only say what is new; write nothing and start nothing", false)
    .option("--drive [host]", "also drive each started run in the background (on this host, or the default)")
    .action(
      action(async (opts: { dryRun: boolean; drive?: string | boolean }) => {
        const c = container();
        const report = await c.resolve("scanIntake").execute({ dryRun: opts.dryRun });
        if (report.isErr()) return { result: err(report.error) };
        const warnings = report.value.rules.flatMap((r) => (r.error ? [`${r.rule}: ${r.error}`] : []));
        if (opts.drive !== undefined && opts.drive !== false) {
          const root = (program.opts() as { root?: string }).root;
          for (const s of report.value.rules.flatMap((r) => r.started)) {
            const driven = await resume(
              c,
              root,
              s.runId,
              typeof opts.drive === "string" ? opts.drive : undefined,
            );
            if (driven.isErr()) warnings.push(`${s.runId}: ${driven.error.message}`);
          }
        }
        return { result: ok(report.value), warnings };
      }),
    );

  intake
    .command("status")
    .description("What intake holds: its issues by rule and status, and the runs it started")
    .action(
      action(async () => {
        const c = container();
        const backlog = await c.resolve("issues").list();
        if (backlog.isErr()) return { result: err(backlog.error) };
        const mine = backlog.value.filter((i) => i.source);
        const byRule: Record<string, Record<string, number>> = {};
        for (const i of mine) {
          const rule = i.source?.rule ?? "";
          const counts = byRule[rule] ?? {};
          counts[i.status] = (counts[i.status] ?? 0) + 1;
          byRule[rule] = counts;
        }
        return {
          result: ok({
            maxActive: c.resolve("config").config.intake.maxActive,
            byRule,
            issues: mine.map((i) => ({
              id: i.id,
              status: i.status,
              source: i.source?.key,
              rule: i.source?.rule,
              ...(i.runId ? { runId: i.runId } : {}),
            })),
          }),
        };
      }),
    );
}
