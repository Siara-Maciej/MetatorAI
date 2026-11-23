import { ok } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";
import { tunnel } from "../tunnel.ts";

/**
 * `metator tunnel --port <n>` (ADR-0106): stdin and stdout joined to a port of this machine. The
 * desktop app runs it in a dev container for each connection of its window to the daemon there;
 * what it prints is the connection's bytes, never an envelope.
 */
export function registerTunnelCommand(program: Command, { action }: CommandContext): void {
  meta(program.command("tunnel"), { folder: true })
    .description(
      "Join stdin and stdout to a TCP port of this machine (the desktop app reaches a daemon in a dev container through it)",
    )
    .requiredOption("--port <n>", "the port to connect to", positiveInt)
    .option("--host <host>", "the address to connect to", "127.0.0.1")
    .action(
      action(async (opts: { port: number; host: string }) => {
        const done = await tunnel(
          { port: opts.port, host: opts.host },
          { input: process.stdin, output: process.stdout },
        );
        return { result: done.andThen(() => ok(null)), streamed: true };
      }),
    );
}
