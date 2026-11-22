import { type LayoutView, PANE_STATES, type PaneState } from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon, inRepo, paneHeaders } from "../daemon-client.ts";
import { positiveInt } from "../options.ts";

/**
 * `metator pane` (R1, ADR-0080): the daemon's workspaces and panes, read-only from the CLI.
 * Agents read, list and wait; typing into a pane is a person's, through a client that attached.
 */
export function registerPaneCommands(program: Command, ctx: CommandContext): void {
  // A daemon that serves a folder takes the repository this command runs in.
  const here = () => ctx.runs().resolve("root");
  const root = ctx.start;
  const pane = program
    .command("pane")
    .description("The runtime's workspaces and panes: list them, read one, wait for its state");

  meta(pane.command("list"), { reads: true })
    .description("Every workspace with its panes and their live state")
    .action(
      ctx.action(async () => {
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        return {
          result: await callDaemon<LayoutView>(
            daemon.value,
            "GET",
            inRepo("/layout", here()),
            undefined,
            paneHeaders(),
          ),
        };
      }),
    );

  meta(pane.command("read <pane>"), { reads: true, typed: true })
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
            inRepo(`/panes/${encodeURIComponent(id)}?lines=${opts.lines}`, here()),
            undefined,
            paneHeaders(),
          ),
        };
      }),
    );

  pane
    .command("split <pane>")
    .description("Split a pane's area: a shell (or a command) to the right of it or below it (S6)")
    .addOption(
      new Option("--dir <dir>", "where the new pane goes").choices(["right", "down"]).default("right"),
    )
    .option("--argv <argv...>", "the command to run in the new pane (default: your shell)")
    .action(
      ctx.action(async (id: string, opts: { dir: "right" | "down"; argv?: string[] }) => {
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        return {
          result: await callDaemon(
            daemon.value,
            "POST",
            inRepo(`/panes/${encodeURIComponent(id)}/split`, here()),
            { dir: opts.dir, ...(opts.argv ? { argv: opts.argv } : {}) },
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
            inRepo(
              `/panes/${encodeURIComponent(id)}/wait?until=${until.join(",")}&timeout=${opts.timeout}`,
              here(),
            ),
            undefined,
            paneHeaders(),
          ),
        };
      }),
    );
}
