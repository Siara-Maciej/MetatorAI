import { OPTION_SCOPES, ok } from "@metator/core";
import { z } from "zod";
import { body, type Call, flag, optional, type Route, route, strings, text } from "../http.ts";

/** `/issues`, `/options`: the backlog (S4) and the options (S1); `/mrs` lives with the reviews (`reviews.ts`). */

const PRIORITY = optional(z.enum(["low", "normal", "high"]));
const AUTONOMY = optional(z.enum(["L0", "L1", "L2"]));
const REFS = optional(z.array(z.unknown()));

/** What an issue's text can be changed to; a field left out is left as it is. */
const patchShape = {
  title: z.string().nullish(),
  body: z.string().nullish(),
  priority: PRIORITY,
  labels: strings,
  refs: REFS,
};
type PatchBody = {
  title?: string | null | undefined;
  body?: string | null | undefined;
  priority?: "low" | "normal" | "high" | undefined;
  labels?: string[] | undefined;
  refs?: unknown[] | undefined;
};
const patchOf = (b: PatchBody) => ({
  ...(typeof b.title === "string" ? { title: b.title } : {}),
  ...(typeof b.body === "string" ? { body: b.body } : {}),
  ...(b.priority ? { priority: b.priority } : {}),
  ...(b.labels ? { labels: b.labels } : {}),
  ...(b.refs ? { refs: b.refs as never[] } : {}),
});
const issue = ({ params }: Call<unknown>) => params.issue as string;

export const BACKLOG_ROUTES: readonly Route[] = [
  // Options: every option with its value and source; a set writes the scope's file.
  route({
    method: "GET",
    pattern: "/options",
    handler: ({ c, query }) => {
      const runId = query.get("run");
      return c
        .resolve("optionStore")
        .list({ ...(runId ? { runId } : {}), changed: query.get("changed") === "true" });
    },
  }),
  route({
    method: "GET",
    pattern: "/options/schema",
    handler: ({ c }) => ok(c.resolve("optionStore").schema()),
  }),
  route({
    method: "POST",
    pattern: "/options/:key+",
    body: body({
      scope: optional(z.enum(OPTION_SCOPES)),
      runId: optional(z.string()),
      reset: flag,
      value: z.unknown().optional(),
    }),
    handler: ({ c, params, body: b }) => {
      const store = c.resolve("optionStore");
      const where = {
        key: params.key as string,
        scope: b.scope ?? "user",
        ...(b.runId ? { runId: b.runId } : {}),
      };
      return b.reset === true ? store.unset(where) : store.set({ ...where, value: b.value });
    },
  }),
  // The backlog: read, add (a person), decide, edit, close, drop, start.
  // Each item with its links (children, what it waits for, a parent's progress) and freshness (ADR-0096).
  route({
    method: "GET",
    pattern: "/issues",
    handler: async ({ c, query }) => {
      const runId = query.get("run");
      return (await c.resolve("backlogWork").list({ ...(runId ? { runId } : {}) })).map((issues) => ({
        issues,
      }));
    },
  }),
  route({
    method: "GET",
    pattern: "/issues/:issue",
    handler: (call) => call.c.resolve("backlogWork").detail(issue(call)),
  }),
  // "Create Backlog item" on a plan: a parent, and a child per step of a system plan.
  route({
    method: "POST",
    pattern: "/issues/from-plan",
    body: body({ runId: text, by: text }),
    handler: ({ c, body: b }) => c.resolve("backlogWork").fromPlan({ runId: b.runId ?? "", by: b.by ?? "" }),
  }),
  // "Analyse" / "Re-analyse": the guide in a pane a person sees, told to record its analysis on the item.
  route({
    method: "POST",
    pattern: "/issues/:issue/analyze",
    body: body({ by: text, host: optional(z.string()) }),
    handler: (call) =>
      call.c
        .resolve("backlogWork")
        .openAnalysis(issue(call), { ...(call.body.host ? { host: call.body.host } : {}) }),
  }),
  // "Make plan": the plan only, its conductor in its own pane; refused while the analysis is stale.
  route({
    method: "POST",
    pattern: "/issues/:issue/plan",
    body: body({ by: text, workflow: optional(z.string()), host: optional(z.string()) }),
    handler: (call) =>
      call.c.resolve("backlogWork").plan(issue(call), {
        ...(call.body.workflow ? { workflow: call.body.workflow } : {}),
        session: { ...(call.body.host ? { host: call.body.host } : {}) },
      }),
  }),
  route({
    method: "POST",
    pattern: "/issues",
    body: body({ ...patchShape, by: text }),
    handler: ({ c, body: b }) => {
      const { title: _title, ...rest } = patchOf(b);
      return c.resolve("issues").add({ title: b.title ?? "", ...rest, by: b.by ?? "" });
    },
  }),
  route({
    method: "POST",
    pattern: "/issues/:issue/decide",
    body: body({ ...patchShape, by: text, decision: optional(z.enum(["add", "drop"])) }),
    handler: (call) =>
      call.c.resolve("issues").decide(issue(call), {
        by: call.body.by ?? "",
        decision: call.body.decision ?? "add",
        ...patchOf(call.body),
      }),
  }),
  route({
    method: "POST",
    pattern: "/issues/:issue/edit",
    body: body(patchShape),
    handler: (call) => call.c.resolve("issues").edit(issue(call), patchOf(call.body)),
  }),
  route({
    method: "POST",
    pattern: "/issues/:issue/close",
    body: body({ by: text }),
    handler: (call) => call.c.resolve("issues").close(issue(call), { by: call.body.by ?? "" }),
  }),
  route({
    method: "POST",
    pattern: "/issues/:issue/drop",
    body: body({ by: text }),
    handler: (call) => call.c.resolve("issues").drop(issue(call), { by: call.body.by ?? "" }),
  }),
  // "Implement": from the plan when it holds, from its review when not; its conductor in its own
  // pane, and the item's thread (or a new one, whose chat opens too).
  route({
    method: "POST",
    pattern: "/issues/:issue/start",
    body: body({
      workflow: optional(z.string()),
      worktree: flag,
      allowDirty: flag,
      autonomy: AUTONOMY,
      host: optional(z.string()),
      by: text,
    }),
    handler: (call) => {
      const b = call.body;
      return call.c.resolve("backlogWork").implement(issue(call), {
        by: b.by ?? "",
        ...(b.workflow ? { workflow: b.workflow } : {}),
        ...(b.worktree === false ? { worktree: false } : {}),
        ...(b.allowDirty === true ? { allowDirty: true } : {}),
        ...(b.autonomy ? { autonomy: b.autonomy } : {}),
        session: { ...(b.host ? { host: b.host } : {}) },
        chat: true,
      });
    },
  }),
];
