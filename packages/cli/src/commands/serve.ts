import { err, ok } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { liveDaemonAt } from "../daemon-client.ts";
import { nonNegativeInt, positiveInt } from "../options.ts";
import { ensureDaemon } from "../serve/ensure.ts";
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
      "--no-restore",
      "leave the agents' sessions of the last daemon paused (continue them with `metator run continue`)",
    )
    .option(
      "--screens-ms <n>",
      "how often every pane's screen is kept on disk (0: only when it stops)",
      nonNegativeInt,
      5000,
    )
    .option(
      "--reviews-ms <n>",
      "how often reviews of my requests and the watched MRs are read (0: never; default: the config's `reviews.everyMs` and `codehost.review.everyMs`)",
      nonNegativeInt,
    )
    .option(
      "--ensure",
      "answer with the daemon that serves this repository, starting one in the background when none does",
      false,
    )
    .option("--timeout <ms>", "with --ensure: how long to wait for a started daemon", positiveInt, 20_000)
    .action(
      ctx.action(
        async (opts: {
          ensure: boolean;
          timeout: number;
          port: number;
          hostname: string;
          pollMs: number;
          superviseMs: number;
          intakeMs?: number;
          reviewsMs?: number;
          restore: boolean;
          screensMs: number;
        }) => {
          const root = () => (program.opts() as { root?: string }).root;
          if (opts.ensure) {
            // The same program and options, without --ensure: the daemon itself, in the foreground
            // of its own process (ADR-0087).
            const given = root();
            const argv = [
              process.argv[0] as string,
              process.argv[1] as string,
              ...(given ? ["--root", given] : []),
              "serve",
              "--port",
              String(opts.port),
              "--hostname",
              opts.hostname,
              "--poll-ms",
              String(opts.pollMs),
              "--supervise-ms",
              String(opts.superviseMs),
              ...(opts.intakeMs === undefined ? [] : ["--intake-ms", String(opts.intakeMs)]),
              ...(opts.reviewsMs === undefined ? [] : ["--reviews-ms", String(opts.reviewsMs)]),
              "--screens-ms",
              String(opts.screensMs),
              ...(opts.restore ? [] : ["--no-restore"]),
            ];
            const background = ctx.container().resolve("backgroundProcess");
            const ensured = await ensureDaemon(
              { roots: servedRoots(ctx), argv, timeoutMs: opts.timeout },
              {
                live: liveDaemonAt,
                start: async (command, cwd, logFile) =>
                  (await background.start(command, cwd, logFile)).unwrapOr(undefined),
                alive: (pid) => background.isAlive(pid),
                sleep: (ms) => Bun.sleep(ms),
                log: (logFile) => background.readLog(logFile, 20),
              },
            );
            return { result: ensured };
          }
          const taken = daemonInTheWay(servedRoots(ctx));
          if (taken) return { result: err(taken) };
          // The signals are heard before daemon.json is written: one that comes while the daemon
          // starts stops it as soon as it has started, and its file goes with it.
          let stopNow: () => void = () => undefined;
          const signalled = new Promise<void>((resolve) => {
            stopNow = resolve;
          });
          process.once("SIGINT", () => stopNow());
          process.once("SIGTERM", () => stopNow());
          const served = await startServer(ctx, {
            port: opts.port,
            hostname: opts.hostname,
            pollMs: opts.pollMs,
            announce: true,
            superviseMs: opts.superviseMs,
            intakeMs: opts.intakeMs ?? true,
            reviewsMs: opts.reviewsMs ?? true,
            restore: opts.restore,
            screensMs: opts.screensMs,
            restart: (c, runId) => resume(c, runId),
          });
          const where = {
            port: served.port,
            hostname: served.hostname,
            pid: served.pid,
            url: `http://${served.hostname}:${served.port}`,
          };
          await signalled;
          await served.stop();
          return { result: ok({ ...where, stopped: true }) };
        },
      ),
    );
}
