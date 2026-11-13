import { err, ok } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { nonNegativeInt, positiveInt } from "../options.ts";
import { daemonInTheWay, servedRoots, startServer } from "../serve/server.ts";
import { resume } from "../sessions.ts";

/**
 * `metator serve` (D3, ADR-0077): the local daemon for the desktop app. The server says where it
 * listens on stderr at once (stdout keeps the one JSON envelope, printed when the daemon stops);
 * the command runs until SIGINT or SIGTERM.
 */
export function registerServeCommand(program: Command, ctx: CommandContext): void {
  meta(program.command("serve"), { audience: "person", folder: true })
    .description(
      "The local daemon the desktop app talks to: state, inbox, activity and PTY sessions on localhost",
    )
    .option("--port <n>", "port to listen on (0: a free one)", nonNegativeInt, 4310)
    .option("--hostname <host>", "address to listen on", "127.0.0.1")
    .option("--poll-ms <n>", "how often sockets look for a change", positiveInt, 1000)
    .option("--supervise-ms <n>", "how often the supervisor ticks (0: never)", nonNegativeInt, 5000)
    .option(
      "--intake-ms <n>",
      "how often the intake rules are scanned (0: never; default: the config's `intake.everyMs`)",
      nonNegativeInt,
    )
    .option(
      "--reviews-ms <n>",
      "how often reviews of my requests are read (0: never; default: the config's `reviews.everyMs`)",
      nonNegativeInt,
    )
    .action(
      ctx.action(
        async (opts: {
          port: number;
          hostname: string;
          pollMs: number;
          superviseMs: number;
          intakeMs?: number;
          reviewsMs?: number;
        }) => {
          const root = () => (program.opts() as { root?: string }).root;
          const taken = daemonInTheWay(servedRoots(ctx));
          if (taken) return { result: err(taken) };
          const served = await startServer(ctx, {
            port: opts.port,
            hostname: opts.hostname,
            pollMs: opts.pollMs,
            announce: true,
            superviseMs: opts.superviseMs,
            intakeMs: opts.intakeMs ?? true,
            reviewsMs: opts.reviewsMs ?? true,
            restart: (c, runId) => resume(c, root(), runId),
            start: (c, runId, host) => resume(c, root(), runId, host || undefined),
          });
          const where = {
            port: served.port,
            hostname: served.hostname,
            pid: served.pid,
            url: `http://${served.hostname}:${served.port}`,
          };
          await new Promise<void>((resolve) => {
            const stop = () => void served.stop().then(resolve);
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
          });
          return { result: ok({ ...where, stopped: true }) };
        },
      ),
    );
}
