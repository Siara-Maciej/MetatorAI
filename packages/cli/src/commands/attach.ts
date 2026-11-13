import {
  type DaemonInfo,
  err,
  MetatorError,
  ok,
  type PaneView,
  type PtyView,
  type Result,
} from "@metator/core";
import type { Command } from "commander";
import { type AttachIo, type AttachOutcome, type AttachSocket, attachPane, isPaneId } from "../attach.ts";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon } from "../daemon-client.ts";
import { byOption } from "../options.ts";
import { who } from "../who.ts";

/** The person's own terminal as the attach client's IO (raw mode on stdin, bytes on stdout). */
export function processIo(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): AttachIo {
  return {
    write: (text) => {
      stdout.write(text);
    },
    onKey: (listener) => {
      const on = (chunk: Buffer | string) => listener(String(chunk));
      stdin.on("data", on);
      stdin.resume();
      return () => {
        stdin.off("data", on);
        stdin.pause();
      };
    },
    onResize: (listener) => {
      stdout.on("resize", listener);
      return () => {
        stdout.off("resize", listener);
      };
    },
    size: () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 }),
    setRaw: (on) => {
      if (stdin.isTTY) stdin.setRawMode(on);
    },
  };
}

/** A WebSocket as the attach client's socket. */
export function webSocket(url: string): AttachSocket {
  const ws = new WebSocket(url);
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => ws.close(),
    onOpen: (l) => {
      ws.onopen = () => l();
    },
    onMessage: (l) => {
      ws.onmessage = (m) => l(String(m.data));
    },
    onClose: (l) => {
      ws.onclose = () => l();
      ws.onerror = () => ws.close();
    },
  };
}

/**
 * `metator attach <pane|run>`: the pane (a run names its conductor pane) in this terminal. A run's
 * pane takes the run's driver lock under `--by` first, so the keys count, and gives it back on
 * detach unless `--keep`. Ctrl-] detaches; the pane goes on.
 */
export function registerAttachCommand(program: Command, ctx: CommandContext): void {
  const root = () => (program.opts() as { root?: string }).root ?? process.cwd();
  meta(program.command("attach <pane>"), { audience: "person" })
    .description(
      "This terminal on a pane (or a run's conductor pane); Ctrl-] detaches. A run's pane takes its driver lock",
    )
    .addOption(byOption("who attaches"))
    .option("--keep", "keep the run's driver lock after detaching")
    .action(
      ctx.action(async (id: string, given: { by?: string; keep?: boolean }) => {
        // Resolved here, not as the option's default: the CLI reference is generated from the options.
        const by = await who(ctx.runs(), given.by);
        if (by.isErr()) return { result: by };
        const opts = { ...given, by: by.value };
        if (!process.stdin.isTTY) {
          return {
            result: err(
              MetatorError.usage(
                "`metator attach` needs a terminal",
                "Read a pane with `metator pane read <pane>` instead.",
              ),
            ),
          };
        }
        if (opts.by.trim() === "")
          return { result: err(MetatorError.usage("say who attaches: --by <name>")) };
        const daemon = findDaemon(root());
        if (daemon.isErr()) return { result: daemon };
        const target = await resolvePane(daemon.value, id);
        if (target.isErr()) return { result: target };
        const { paneId, runId } = target.value;
        if (runId) {
          const lock = await callDaemon(daemon.value, "POST", `/runs/${encodeURIComponent(runId)}/attach`, {
            by: opts.by,
          });
          if (lock.isErr()) return { result: lock };
        }
        const url = `${daemon.value.url.replace(/^http/, "ws")}/ws/pane/${encodeURIComponent(paneId)}?by=${encodeURIComponent(opts.by)}`;
        const outcome = await attachPane({ paneId, io: processIo(), connect: () => webSocket(url) });
        let released = false;
        if (runId && !opts.keep) {
          const r = await callDaemon(daemon.value, "POST", `/runs/${encodeURIComponent(runId)}/release`, {});
          released = r.isOk();
        }
        return {
          result: outcome.map((o): AttachOutcome & { runId?: string; released: boolean } => ({
            ...o,
            ...(runId ? { runId } : {}),
            released,
          })),
        };
      }),
    );
}

/** The pane to attach: `w1:p2` as is (with its run), a run id as its conductor pane. */
async function resolvePane(
  daemon: DaemonInfo,
  id: string,
): Promise<Result<{ readonly paneId: string; readonly runId?: string }, MetatorError>> {
  if (isPaneId(id)) {
    const pane = await callDaemon<{ pane: PaneView }>(daemon, "GET", `/panes/${encodeURIComponent(id)}`);
    if (pane.isErr()) return err(pane.error);
    if (!pane.value.pane.live?.alive)
      return err(
        new MetatorError("NOT_FOUND", `pane ${id} has no live terminal`, {
          hint: "`metator pane list` shows the live panes.",
        }),
      );
    return ok({ paneId: id, ...(pane.value.pane.runId ? { runId: pane.value.pane.runId } : {}) });
  }
  const pty = await callDaemon<{ session: PtyView | null }>(
    daemon,
    "GET",
    `/runs/${encodeURIComponent(id)}/pty`,
  );
  if (pty.isErr()) return err(pty.error);
  if (!pty.value.session?.alive || pty.value.session.role !== "conductor")
    return err(
      new MetatorError("NOT_FOUND", `run ${id} has no live conductor pane`, {
        hint: "`metator run start` opens one.",
      }),
    );
  return ok({ paneId: pty.value.session.paneId, runId: id });
}
