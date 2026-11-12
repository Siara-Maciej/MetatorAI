import { ok, type SupervisorReport } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { resume } from "../sessions.ts";

/**
 * `metator supervise` (D4, ADR-0077): the supervisor's loop in a process of its own (the daemon
 * runs the same loop). `--once` does one tick and prints its report, for scripts and tests.
 */
export function registerSuperviseCommand(program: Command, ctx: CommandContext): void {
  const root = () => (program.opts() as { root?: string }).root;
  program
    .command("supervise")
    .description("Keep runs alive: restart drives that died, nudge idle agents, watch the attention budget")
    .option("--once", "one tick, then the report", false)
    .option("--interval-ms <n>", "how often to tick", positiveInt, 5000)
    .action(
      ctx.action(async (opts: { once: boolean; intervalMs: number }) => {
        const c = ctx.container();
        const supervisor = c.resolve("supervisor")((runId) => resume(c, root(), runId));
        if (opts.once) return { result: await supervisor.tick() };
        const ticks: SupervisorReport[] = [];
        let stop = false;
        process.once("SIGINT", () => {
          stop = true;
        });
        process.once("SIGTERM", () => {
          stop = true;
        });
        while (!stop) {
          const r = await supervisor.tick();
          if (r.isErr()) return { result: r };
          ticks.push(r.value);
          await Bun.sleep(opts.intervalMs);
        }
        return { result: ok({ ticks: ticks.length, last: ticks.at(-1) ?? null }) };
      }),
    );
}
