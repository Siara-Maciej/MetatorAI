import { type CallerPane, type MetatorError, ok, type SessionView } from "@metator/core";
import { z } from "zod";
import { body, type Call, type Daemon, denied, optional, type Route, route, text } from "../http.ts";

/**
 * Steering a task's sessions (ADR-0093): `/sessions`, `/panes/:pane/tell|interrupt|said`. A call
 * with a pane's token comes from that pane (the task's main chat, in whichever repository the
 * daemon serves it); a call without one is a person's.
 */

/** The pane a token belongs to, in whichever repository the daemon serves. */
async function callerOf(daemon: Daemon, token: string): Promise<CallerPane | undefined> {
  for (const r of daemon.places()) {
    const pane = await r.c.resolve("panes").authorize(token);
    if (pane) return pane;
  }
  return undefined;
}

/** Only the task's main chat (its token) or a person (no token) steers a session. */
async function mainChatOrPerson({ c, token, params, daemon }: Call): Promise<MetatorError | undefined> {
  if (!token) return undefined;
  const from = await callerOf(daemon, token);
  if (!from) return denied("unknown pane token");
  return c.resolve("sessionSteering").refusal(params.pane as string, from);
}

const words = body({ text, by: optional(z.string()) });

/** Types what waits for idle agents now, in every repository: a line posted is not left to the next look. */
async function deliver(daemon: Daemon): Promise<void> {
  for (const r of daemon.places()) await r.c.resolve("paneMail").tick();
}

export const SESSION_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/sessions",
    global: true,
    handler: async ({ query, daemon }) => {
      const task = query.get("task") ?? undefined;
      const sessions: SessionView[] = [];
      for (const r of daemon.places()) {
        const listed = await r.c.resolve("sessionSteering").list(task ? { task } : {});
        if (listed.isErr()) return listed;
        // In a folder a repository is named as the folder names it.
        sessions.push(...listed.value.map((s) => (r.name ? { ...s, repo: r.name } : s)));
      }
      return ok({ sessions });
    },
  }),
  route({
    method: "POST",
    pattern: "/panes/:pane/tell",
    body: words,
    guard: mainChatOrPerson,
    handler: async ({ c, params, body: b, token, daemon }) => {
      const from = token ? await callerOf(daemon, token) : undefined;
      const told = await c.resolve("sessionSteering").tell({
        paneId: params.pane as string,
        text: b.text ?? "",
        ...(from ? { from } : b.by ? { by: b.by } : {}),
      });
      if (told.isOk()) await deliver(daemon);
      return told;
    },
  }),
  route({
    method: "POST",
    pattern: "/panes/:pane/interrupt",
    body: words,
    guard: mainChatOrPerson,
    handler: async ({ c, params, body: b, token, daemon }) => {
      const from = token ? await callerOf(daemon, token) : undefined;
      return c.resolve("sessionSteering").interrupt({
        paneId: params.pane as string,
        text: b.text ?? "",
        ...(from ? { from } : b.by ? { by: b.by } : {}),
      });
    },
  }),
  // The host's user-prompt hook of a pane: what the person sent there themselves. The task's main
  // chat, wherever the daemon serves it, hears of it in one line.
  route({
    method: "POST",
    pattern: "/panes/:pane/said",
    body: body({ text }),
    guard: async ({ c, token, params }) => {
      const own = token ? await c.resolve("panes").authorize(token) : undefined;
      return own && own.id === params.pane
        ? undefined
        : denied(`only pane ${params.pane} itself says what was typed into it`);
    },
    handler: async ({ c, params, body: b, daemon }) => {
      const said = await c
        .resolve("sessionSteering")
        .directTalk({ paneId: params.pane as string, text: b.text ?? "" });
      if (said.isErr()) return said;
      const told: string[] = [];
      if (said.value)
        for (const r of daemon.places()) {
          const chats = await r.c.resolve("sessionSteering").tellChats(said.value.task, said.value.line);
          if (chats.isErr()) return chats;
          told.push(...chats.value);
        }
      if (told.length > 0) await deliver(daemon);
      return ok({ told });
    },
  }),
];
