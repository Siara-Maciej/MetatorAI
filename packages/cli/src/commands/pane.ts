import { type LayoutView, PANE_STATES, type PaneState } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon, paneHeaders } from "../daemon-client.ts";
import { positiveInt } from "../options.ts";

/**
 * `metator pane` (R1, ADR-0080): the daemon's workspaces and panes, read-only from the CLI.
 * Agents read, list and wait; typing into a pane is a person's, through a client that attached.
 */
export function registerPaneCommands(program: Command, ctx: CommandContext): void {
  const root = () => (program.opts() as { root?: string }).root ?? process.cwd();
  const pane = program
    .command("pane")
    .description("The runtime's workspaces and panes: list them, read one, wait for its state");

  pane
    .command("list")
    .description("Every workspace with its panes and their live state")
    .action(
      ctx.action(async () => {
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        return {
          result: await callDaemon<LayoutView>(daemon.value, "GET", "/layout", undefined, paneHeaders()),
        };
      }),
    );

  pane
    .command("read <pane>")
    .description("The last lines of a pane's output, without terminal escapes")
    .option("--lines <n>", "how many lines", positiveInt, 80)
    .action(
      ctx.action(async (id: string, opts: { lines: number }) => {
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        return {
          result: await callDaemon(
            daemon.value,
            "GET",
            `/panes/${encodeURIComponent(id)}?lines=${opts.lines}`,
            undefined,
            paneHeaders(),
          ),
        };
      }),
    );

  pane
    .command("wait <pane>")
    .description(
      "Wait until the pane is in a state: idle or exited (default: either), blocked, waiting, working",
    )
    .option(
      "--until <state>",
      "working, blocked, waiting, idle or exited; repeat for several",
      (v: string, all: string[]) => [...all, v],
      [] as string[],
    )
    .option("--timeout <ms>", "give up after this long", positiveInt, 60_000)
    .action(
      ctx.action(async (id: string, opts: { until: string[]; timeout: number }) => {
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        const until = (opts.until.length > 0 ? opts.until : ["idle", "exited"]).filter((u): u is PaneState =>
          (PANE_STATES as readonly string[]).includes(u),
        );
        return {
          result: await callDaemon(
            daemon.value,
            "GET",
            `/panes/${encodeURIComponent(id)}/wait?until=${until.join(",")}&timeout=${opts.timeout}`,
            undefined,
            paneHeaders(),
          ),
        };
      }),
    );
}
