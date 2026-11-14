import { err, MESSAGE_TOPICS, MetatorError, ok } from "@metator/core";
import { z } from "zod";
import { body, type Call, count, denied, flag, optional, type Route, route, strings, text } from "../http.ts";

/** `/runs` and `/runs/:run/*`: what a person or a conductor pane does to a run. */

const AUTONOMY = optional(z.enum(["L0", "L1", "L2"]));

/**
 * A call from inside a pane carries the pane's token: it may steer its own run only, and only
 * from the conductor's pane (R2). A call without a token is a person's.
 */
async function conductorOnly({ c, token, params }: Call): Promise<MetatorError | undefined> {
  if (!token) return undefined;
  const runId = params.run as string;
  const pane = await c.resolve("panes").authorize(token);
  if (pane && pane.runId === runId && pane.role === "conductor") return undefined;
  return denied(
    pane
      ? `pane ${pane.id} (${pane.role}${pane.runId ? ` of run ${pane.runId}` : ""}) may not steer run ${runId}`
      : "unknown pane token",
    "Only the run's conductor pane delegates and collects; a worker reports with `metator run result`.",
  );
}

const run = ({ params }: Call<unknown>) => params.run as string;

export const RUN_ROUTES: readonly Route[] = [
  // The same start as `metator run new`: the run, its worktree's dependencies, its drive.
  route({
    method: "POST",
    pattern: "/runs",
    body: body({
      workflow: text,
      task: text,
      autonomy: AUTONOMY,
      worktree: flag,
      allowDirty: flag,
      setup: flag,
      parent: optional(z.string()),
      drive: optional(z.string()),
    }),
    handler: async ({ c, body: b }) => {
      const started = await c.resolve("startRun").execute({
        workflow: b.workflow ?? "",
        task: b.task ?? "",
        ...(b.autonomy ? { autonomy: b.autonomy } : {}),
        ...(b.worktree === true
          ? { worktree: b.allowDirty === true ? { allowDirty: true } : {} }
          : b.allowDirty === true
            ? { allowDirty: true }
            : {}),
        ...(b.parent ? { parent: b.parent } : {}),
        setup: b.setup !== false,
        ...(b.drive ? { drive: { host: b.drive } } : {}),
      });
      if (started.isErr()) return started;
      const { run: created, setup, setupError, drive, driveError, warnings } = started.value;
      return {
        result: started.map(() => ({
          run: created,
          ...(setup ? { setup } : setupError ? { setup: { error: setupError } } : {}),
          ...(drive
            ? { drive: { host: b.drive, stage: drive.stage, started: drive.started } }
            : driveError
              ? { drive: { error: driveError.message } }
              : {}),
        })),
        warnings,
      };
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/start",
    body: body({ host: optional(z.string()) }),
    guard: conductorOnly,
    handler: (call) =>
      call.c
        .resolve("conductor")
        .start({ runId: run(call), ...(call.body.host ? { host: call.body.host } : {}) }),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/delegate",
    body: body({
      stage: optional(z.string()),
      agent: text,
      card: text,
      name: optional(z.string()),
      host: optional(z.string()),
    }),
    guard: conductorOnly,
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("conductor").delegate({
        runId: run(call),
        ...(b.stage ? { stage: b.stage } : {}),
        agent: b.agent ?? "",
        card: b.card ?? "",
        ...(b.name ? { name: b.name } : {}),
        ...(b.host ? { host: b.host } : {}),
      });
    },
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/workers",
    handler: async (call) =>
      (await call.c.resolve("conductor").workers(run(call))).map((workers) => ({
        runId: run(call),
        workers,
      })),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/wait",
    handler: (call) =>
      call.c.resolve("conductor").wait({
        runId: run(call),
        worker: call.query.get("worker") ?? "",
        timeoutMs: Number(call.query.get("timeout")) || 60_000,
      }),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/collect",
    body: body({ worker: text }),
    guard: conductorOnly,
    handler: (call) =>
      call.c.resolve("conductor").collect({ runId: run(call), worker: call.body.worker ?? "" }),
  }),
  // The editor, the change and the notes on it (S5).
  route({
    method: "POST",
    pattern: "/runs/:run/open-editor",
    body: body({ file: optional(z.string()), line: count }),
    handler: (call) =>
      call.c.resolve("openEditor").execute({
        runId: run(call),
        ...(call.body.file ? { file: call.body.file } : {}),
        ...(call.body.line !== undefined ? { line: call.body.line } : {}),
      }),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/review",
    handler: (call) => {
      const file = call.query.get("file");
      return call.c.resolve("runChanges").execute({ runId: run(call), ...(file ? { file } : {}) });
    },
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/review-notes",
    handler: (call) => call.c.resolve("reviewNotes").list(run(call)),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/review-notes",
    body: body({
      file: optional(z.string()),
      line: count,
      side: optional(z.enum(["old", "new"])),
      text,
      by: text,
    }),
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("reviewNotes").add(run(call), {
        ...(b.file ? { file: b.file } : {}),
        ...(b.line !== undefined ? { line: b.line } : {}),
        ...(b.side ? { side: b.side } : {}),
        text: b.text ?? "",
        by: b.by ?? "",
      });
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/review-send",
    body: body({ by: text }),
    handler: (call) => call.c.resolve("reviewNotes").send(run(call), { by: call.body.by ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/review-note-status",
    body: body({ id: text, status: optional(z.enum(["draft", "sent", "addressed"])) }),
    handler: (call) =>
      call.c.resolve("reviewNotes").setStatus(run(call), call.body.id ?? "", call.body.status ?? "addressed"),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/board",
    handler: (call) => {
      const timeline = Number(call.query.get("timeline"));
      return call.c.resolve("planBoard").execute({ runId: run(call), ...(timeline ? { timeline } : {}) });
    },
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/activity",
    handler: async (call) => {
      const tail = Number(call.query.get("tail")) || undefined;
      const a = await call.c.resolve("runJournal").activity(run(call));
      return a.map((entries) => ({ runId: run(call), entries: tail ? entries.slice(-tail) : entries }));
    },
  }),
  // The same brief as `metator run brief --peek`: a `since` that is no time is a usage error here
  // too; reading it marks nothing (`POST seen` does).
  route({
    method: "GET",
    pattern: "/runs/:run/brief",
    handler: (call) => {
      const since = call.query.get("since");
      return call.c
        .resolve("briefRun")
        .execute({ runId: run(call), peek: true, ...(since ? { since } : {}) });
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/seen",
    handler: async (call) =>
      (await call.c.resolve("runJournal").markSeen(run(call))).map((at) => ({ runId: run(call), at })),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/messages",
    handler: async (call) =>
      (await call.c.resolve("runMessages").list(run(call))).map((messages) => ({
        runId: run(call),
        messages,
      })),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/pty",
    handler: (call) => {
      const broker = call.c.resolve("ptyBroker");
      const conductor = broker.byRun(run(call))[0];
      return ok({ session: conductor ?? null, backlog: conductor ? broker.backlog(conductor.paneId) : "" });
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/attach",
    body: body({ by: text }),
    handler: (call) => call.c.resolve("driverLock").attach({ runId: run(call), by: call.body.by ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/release",
    handler: (call) => call.c.resolve("driverLock").release({ runId: run(call) }),
  }),
  // The same answer as `metator run answer` (`always`: also a policy); carried out by a drive:
  // with none alive on an active run, the run is driven again. Never an escalated run.
  route({
    method: "POST",
    pattern: "/runs/:run/answer",
    body: body({
      question: text,
      choices: strings,
      text: optional(z.string()),
      by: text,
      origin: optional(z.string()),
      always: flag,
    }),
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("answerQuestion").execute({
        runId: run(call),
        question: b.question ?? "",
        choices: b.choices ?? [],
        ...(b.text ? { text: b.text } : {}),
        by: b.by ?? "",
        // From the decision card, without opening the session: what 11a counts.
        ...(b.origin === "inbox" ? { origin: "inbox" as const } : {}),
        always: b.always === true,
        drive: true,
      });
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/approve",
    body: body({ gate: text, by: text, choice: optional(z.string()), via: optional(z.string()) }),
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("approveRun").execute({
        runId: run(call),
        gate: b.gate ?? "",
        by: b.by ?? "",
        ...(b.choice ? { choice: b.choice } : {}),
        ...(b.via === "chat" ? { via: "chat" as const } : {}),
      });
    },
  }),
  // An escalated run back at its stage, and driven on at once (R9): what the app's Resume does.
  // Always a named person's own act; nothing else resumes a run.
  route({
    method: "POST",
    pattern: "/runs/:run/resume",
    body: body({ by: text, drive: flag, host: optional(z.string()) }),
    handler: async (call) => {
      const b = call.body;
      const resumed = await call.c.resolve("resumeRun").execute({ runId: run(call), by: b.by ?? "" });
      if (resumed.isErr()) return resumed;
      const drive =
        b.drive === false
          ? undefined
          : await call.c
              .resolve("ensureDriven")
              .execute({ runId: run(call), ...(b.host ? { host: b.host } : {}) });
      return resumed.map((value) => ({
        run: value,
        ...(drive
          ? {
              drive: drive.isOk()
                ? { stage: drive.value.stage, started: drive.value.started }
                : {
                    error: drive.error.message,
                    ...(drive.error.hint ? { hint: drive.error.hint } : {}),
                  },
            }
          : {}),
      }));
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/stop",
    handler: async (call) =>
      (await call.c.resolve("runDrivers").stop(run(call))).map((r) => ({ runId: run(call), ...r })),
  }),
  // The same close as `metator run close`: the summary of a finished run; with a reason, an active
  // or escalated run is aborted first; the panes go with the run, the worktree when asked.
  route({
    method: "POST",
    pattern: "/runs/:run/close",
    body: body({ aborted: flag, reason: optional(z.string()), removeWorktree: flag, force: flag }),
    handler: (call) => {
      const b = call.body;
      const reason = b.reason?.trim();
      if (b.aborted === true && !reason)
        return err(MetatorError.usage("say why the run is aborted: reason", "An abort records its reason."));
      return call.c.resolve("endRun").execute({
        runId: run(call),
        ...(reason ? { abortReason: reason } : {}),
        removeWorktree: b.removeWorktree === true,
        force: b.force === true,
      });
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/message",
    body: body({
      from: text,
      topic: optional(z.enum(MESSAGE_TOPICS)),
      text,
      refs: strings,
      by: text,
    }),
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("runMessages").send({
        from: b.from ?? "",
        to: run(call),
        topic: b.topic ?? "info",
        text: b.text ?? "",
        refs: b.refs ?? [],
        by: b.by ?? "",
      });
    },
  }),
  // The explicit start of a run's terminal session; a socket on `/ws/pty/<run>` only finds it.
  route({
    method: "POST",
    pattern: "/runs/:run/pty-open",
    body: body({ host: optional(z.string()), cols: count, rows: count }),
    handler: async (call) => {
      const b = call.body;
      const opened = await call.c.resolve("panes").openRun({
        runId: run(call),
        ...(b.host ? { host: b.host } : {}),
        ...(b.cols !== undefined && b.rows !== undefined ? { size: { cols: b.cols, rows: b.rows } } : {}),
      });
      return opened.map((p) => p.live);
    },
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/close-panes",
    handler: (call) => call.c.resolve("panes").closeRun(run(call)),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/pty-close",
    handler: async (call) => {
      const conductor = call.c.resolve("ptyBroker").byRun(run(call))[0];
      if (!conductor) return ok({ closed: false });
      return call.c.resolve("panes").closePane(conductor.paneId);
    },
  }),
];
