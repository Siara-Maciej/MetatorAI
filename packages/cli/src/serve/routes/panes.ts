import { PANE_ROLES, PANE_STATES, type PaneState, SplitNodeSchema } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { z } from "zod";
import { body, count, denied, flag, optional, type Route, route, strings } from "../http.ts";

/** `/panes`, `/tabs`, `/workspaces`, `/layout`: the terminals the daemon owns (ADR-0080). */

/** The shell of a new shell pane: the person's `terminal.shell`, else `$SHELL`, else `sh`. */
async function defaultShell(c: MetatorContainer): Promise<string> {
  const shell = await c.resolve("optionStore").get("terminal.shell");
  const configured = shell.isOk() && typeof shell.value.value === "string" ? shell.value.value : "";
  return configured !== "" ? configured : (process.env.SHELL ?? "sh");
}

export const PANE_ROUTES: readonly Route[] = [
  route({ method: "GET", pattern: "/layout", handler: ({ c }) => c.resolve("panes").view() }),
  route({
    method: "POST",
    pattern: "/panes",
    body: body({
      workspace: optional(z.string()),
      runId: optional(z.string()),
      label: optional(z.string()),
      role: optional(z.enum(PANE_ROLES)),
      host: optional(z.string()),
      agent: optional(z.string()),
      prompt: optional(z.string()),
      cwd: optional(z.string()),
      tab: optional(z.string()),
      newTab: flag,
      argv: strings,
      cols: count,
      rows: count,
    }),
    handler: async ({ c, body: b }) => {
      const panes = c.resolve("panes");
      // A pane of a run's workspace (made when missing) or of a named workspace.
      let workspace = b.workspace;
      if (!workspace) {
        const w = await panes.openWorkspace({
          ...(b.runId ? { runId: b.runId } : {}),
          ...(b.label && !b.runId ? { label: b.label } : {}),
        });
        if (w.isErr()) return w;
        workspace = w.value.id;
      }
      // A shell pane asked for without a command runs the person's shell, as a split does.
      const argv =
        b.argv ?? (b.role === "shell" && !b.host && !b.agent ? [await defaultShell(c)] : undefined);
      // A fresh tab for the pane (S6): named after the pane's label.
      let tab = b.tab;
      if (b.newTab === true) {
        const opened = await panes.openTab(workspace, b.label ?? "tab");
        if (opened.isErr()) return opened;
        tab = opened.value;
      }
      return panes.openPane({
        workspace,
        ...(tab ? { tab } : {}),
        role: b.role ?? "shell",
        ...(b.label ? { label: b.label } : {}),
        ...(b.cwd ? { cwd: b.cwd } : {}),
        process: argv
          ? { kind: "command", argv }
          : {
              kind: "host",
              ...(b.host ? { host: b.host } : {}),
              agent: b.agent ?? "session",
              prompt: b.prompt ?? "",
            },
        ...(b.cols !== undefined && b.rows !== undefined ? { size: { cols: b.cols, rows: b.rows } } : {}),
      });
    },
  }),
  route({
    method: "GET",
    pattern: "/panes/:pane",
    handler: async ({ c, params, query }) => {
      const paneId = params.pane as string;
      const panes = c.resolve("panes");
      const lines = Number(query.get("lines")) || 80;
      return (await panes.pane(paneId)).map((p) => ({
        pane: p,
        text: panes.read(paneId, lines),
        backlog: c.resolve("ptyBroker").backlog(paneId),
      }));
    },
  }),
  route({
    method: "GET",
    pattern: "/panes/:pane/wait",
    handler: ({ c, params, query }) => {
      const until = (query.get("until") ?? "idle,exited")
        .split(",")
        .filter((u): u is PaneState => (PANE_STATES as readonly string[]).includes(u));
      const timeoutMs = Number(query.get("timeout")) || 60_000;
      return c.resolve("panes").wait(params.pane as string, { until, timeoutMs });
    },
  }),
  route({
    method: "GET",
    pattern: "/panes/:pane/state",
    handler: ({ c, params }) => c.resolve("paneSensor").state(params.pane as string),
  }),
  route({
    method: "POST",
    pattern: "/panes/:pane/close",
    handler: ({ c, params }) => c.resolve("panes").closePane(params.pane as string),
  }),
  // The editor on the pane's directory (S5), at a file and line when given.
  route({
    method: "POST",
    pattern: "/panes/:pane/open-editor",
    body: body({ file: optional(z.string()), line: count }),
    handler: ({ c, params, body: b }) =>
      c.resolve("openEditor").execute({
        paneId: params.pane as string,
        ...(b.file ? { file: b.file } : {}),
        ...(b.line !== undefined ? { line: b.line } : {}),
      }),
  }),
  // Split (S6): a shell (the person's `terminal.shell`, else $SHELL) beside or below the pane.
  route({
    method: "POST",
    pattern: "/panes/:pane/split",
    body: body({ dir: optional(z.enum(["right", "down"])), argv: strings, cols: count, rows: count }),
    handler: async ({ c, params, body: b }) =>
      c.resolve("panes").splitPane(params.pane as string, {
        dir: b.dir ?? "right",
        process: { kind: "command", argv: b.argv && b.argv.length > 0 ? b.argv : [await defaultShell(c)] },
        ...(b.cols !== undefined && b.rows !== undefined ? { size: { cols: b.cols, rows: b.rows } } : {}),
      }),
  }),
  // A hook of the pane's own session says the agent works (R3): the pane's token, no other.
  route({
    method: "POST",
    pattern: "/panes/:pane/heartbeat",
    guard: async ({ c, token, params }) => {
      const own = token ? await c.resolve("panes").authorize(token) : undefined;
      return own && own.id === params.pane
        ? undefined
        : denied(`only pane ${params.pane} itself reports its heartbeat`);
    },
    handler: ({ c, params }) =>
      c
        .resolve("ptyBroker")
        .heartbeat(params.pane as string)
        .map(() => ({ paneId: params.pane as string, at: new Date().toISOString() })),
  }),
  route({
    method: "POST",
    pattern: "/tabs/:tab/tree",
    body: body({ tree: SplitNodeSchema }),
    handler: ({ c, params, body: b }) => c.resolve("panes").setTree(params.tab as string, b.tree),
  }),
  route({
    method: "POST",
    pattern: "/workspaces/:workspace/close",
    handler: ({ c, params }) => c.resolve("panes").closeWorkspace(params.workspace as string),
  }),
];
