import { ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { startServer } from "../serve/server.ts";

/**
 * `metator serve` (D3, ADR-0077): the local daemon for the desktop app. The server says where it
 * listens on stderr at once (stdout keeps the one JSON envelope, printed when the daemon stops);
 * the command runs until SIGINT or SIGTERM.
 */
export function registerServeCommand(program: Command, ctx: CommandContext): void {
  program
    .command("serve")
    .description(
      "The local daemon the desktop app talks to: state, inbox, activity and PTY sessions on localhost",
    )
    .option("--port <n>", "port to listen on (0: a free one)", (v: string) => Number(v), 4310)
    .option("--hostname <host>", "address to listen on", "127.0.0.1")
    .option("--poll-ms <n>", "how often sockets look for a change", positiveInt, 1000)
    .action(
      ctx.action(async (opts: { port: number; hostname: string; pollMs: number }) => {
        const served = await startServer(ctx, {
          port: opts.port,
          hostname: opts.hostname,
          pollMs: opts.pollMs,
          announce: true,
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
      }),
    );
}
