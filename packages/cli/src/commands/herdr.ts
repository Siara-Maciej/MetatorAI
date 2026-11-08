import { err, type HerdrSync, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

/**
 * `metator herdr` (E2, ADR-0079): runs' host sessions in herdr. herdr owns the terminals and the
 * windows; MetatorAI opens a workspace per run with its host and its guard, mirrors each run's
 * stage into herdr's sidebar, and closes the workspace when asked.
 */
export function registerHerdrCommand(program: Command, ctx: CommandContext): void {
  const herdr = program
    .command("herdr")
    .description(
      "Run hosts in herdr under MetatorAI's guard: open a run's session, sync its state, close it",
    );

  herdr
    .command("open")
    .description("Open the run's host session in a herdr workspace of its own (or find the open one)")
    .option("--run <id>", "run id (default: latest)")
    .option("--host <id>", "copilot, claude, opencode (default: the run's host, else supervisor.hostOrder)")
    .action(
      ctx.action(async (opts: { run?: string; host?: string }) => ({
        result: await ctx
          .container()
          .resolve("herdrSessions")
          .open({ ...(opts.run ? { runId: opts.run } : {}), ...(opts.host ? { host: opts.host } : {}) }),
      })),
    );

  herdr
    .command("sync")
    .description("Write each run's stage to herdr's sidebar and note host prompts herdr sees in the run")
    .option("--watch", "keep syncing until stopped", false)
    .option("--interval-ms <n>", "with --watch: how often", positiveInt, 3000)
    .action(
      ctx.action(async (opts: { watch: boolean; intervalMs: number }) => {
        const sessions = ctx.container().resolve("herdrSessions");
        if (!opts.watch) return { result: (await sessions.sync()).map((runs) => ({ runs })) };
        let stop = false;
        process.once("SIGINT", () => {
          stop = true;
        });
        process.once("SIGTERM", () => {
          stop = true;
        });
        let last: readonly HerdrSync[] = [];
        let rounds = 0;
        while (!stop) {
          const r = await sessions.sync();
          if (r.isErr()) return { result: r };
          last = r.value;
          rounds++;
          await Bun.sleep(opts.intervalMs);
        }
        return { result: ok({ rounds, runs: last }) };
      }),
    );

  herdr
    .command("close")
    .description("Close the run's herdr workspace (its processes end) and forget it")
    .option("--run <id>", "run id (default: latest)")
    .action(
      ctx.action(async (opts: { run?: string }) => ({
        result: await ctx
          .container()
          .resolve("herdrSessions")
          .close(opts.run ? { runId: opts.run } : {}),
      })),
    );

  herdr
    .command("plugin <action>")
    .description(
      "What herdr's MetatorAI plugin runs: attach, release, sync, inbox, for the run of herdr's current workspace",
    )
    .action(
      ctx.action(async (action: string) => {
        const workspace = workspaceOf(process.env);
        if (!workspace)
          return {
            result: err(
              MetatorError.usage(
                "no herdr workspace in this process",
                "herdr's plugin passes HERDR_WORKSPACE_ID (or HERDR_PANE_ID, or the event's pane).",
              ),
            ),
          };
        const located = await ctx.container().resolve("herdrSessions").locate(workspace);
        if (located.isErr()) return { result: located };
        if (!located.value)
          return {
            result: err(
              MetatorError.notFound(`a MetatorAI run for herdr workspace ${workspace}`, {
                hint: "Open one with `metator herdr open --run <id>`.",
              }),
            ),
          };
        const { root, runId } = located.value;
        const c = ctx.containerAt(root);
        const by = process.env.USER ?? process.env.USERNAME ?? "";
        switch (action) {
          case "attach":
            return { result: await c.resolve("driverLock").attach({ runId, by }) };
          case "release":
            return { result: await c.resolve("driverLock").release({ runId }) };
          case "sync":
            return { result: (await c.resolve("herdrSessions").sync()).map((runs) => ({ runs })) };
          case "inbox": {
            // The decision inbox and sessions view of the run's repository, in herdr's pane.
            const ui = Bun.spawn(
              [process.argv[0] as string, process.argv[1] as string, "--root", root, "ui"],
              {
                stdio: ["inherit", "inherit", "inherit"],
              },
            );
            return { result: ok({ runId, root, exitCode: await ui.exited }) };
          }
          default:
            return {
              result: err(
                MetatorError.usage(
                  `unknown plugin action ${action}`,
                  "Actions: attach, release, sync, inbox.",
                ),
              ),
            };
        }
      }),
    );
}

/** herdr's workspace for this process: its own id, the pane's, or the event's pane (`w3:p1` → `w3`). */
export function workspaceOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.HERDR_WORKSPACE_ID) return env.HERDR_WORKSPACE_ID;
  let pane = env.HERDR_PANE_ID;
  if (!pane && env.HERDR_PLUGIN_EVENT_JSON) {
    try {
      const event = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON) as {
        pane_id?: unknown;
        pane?: { pane_id?: unknown };
      };
      const id = event.pane_id ?? event.pane?.pane_id;
      if (typeof id === "string") pane = id;
    } catch {
      /* not JSON: no pane */
    }
  }
  return pane?.split(":")[0] || undefined;
}
