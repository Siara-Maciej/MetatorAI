import { z } from "zod";
import { body, type Call, denied, optional, type Route, route, text } from "../http.ts";

/**
 * `/runs/:run/plan` and `/system/plans`: plans a person reads, lints, changes and approves in the
 * app (ADR-0087). A write names the digest it was based on (409 CONFLICT when the plan changed
 * since) and who makes it; the use cases check the document and record the edit.
 */

/** A plan is changed by a person in the app; an agent's pane writes its files where its stage says. */
export async function personOnly({ token }: Call): Promise<ReturnType<typeof denied> | undefined> {
  return token
    ? denied(
        "a plan is changed and approved by a person in the app, not from a pane",
        "Write the plan file the stage names; a person reviews it.",
      )
    : undefined;
}

/** The document a client sends: any JSON object, checked against its schema by the use case. */
const document = z.unknown();

const run = ({ params }: Call<unknown>) => params.run as string;
const plan = ({ params }: Call<unknown>) => params.plan as string;

export const PLAN_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/runs/:run/plan",
    handler: (call) => call.c.resolve("runPlans").view(run(call)),
  }),
  route({
    method: "POST",
    pattern: "/runs/:run/plan/lint",
    body: body({ plan: document }),
    handler: (call) => call.c.resolve("runPlans").lint(run(call), call.body.plan),
  }),
  route({
    method: "PUT",
    pattern: "/runs/:run/plan",
    body: body({ plan: document, digest: z.string().nullable(), by: text, note: optional(z.string()) }),
    guard: personOnly,
    handler: (call) =>
      call.c.resolve("runPlans").save(run(call), {
        plan: call.body.plan,
        digest: call.body.digest,
        by: call.body.by ?? "",
        ...(call.body.note ? { note: call.body.note } : {}),
      }),
  }),
  route({
    method: "GET",
    pattern: "/system/plans",
    handler: (call) => call.c.resolve("systemPlans").list(),
  }),
  route({
    method: "GET",
    pattern: "/system/plans/:plan",
    handler: (call) => call.c.resolve("systemPlans").view(plan(call)),
  }),
  route({
    method: "POST",
    pattern: "/system/plans/:plan/lint",
    body: body({ plan: document }),
    handler: (call) => call.c.resolve("systemPlans").lint(plan(call), call.body.plan),
  }),
  route({
    method: "PUT",
    pattern: "/system/plans/:plan",
    body: body({ plan: document, digest: z.string(), by: text, note: optional(z.string()) }),
    guard: personOnly,
    handler: (call) =>
      call.c.resolve("systemPlans").save(plan(call), {
        plan: call.body.plan,
        digest: call.body.digest,
        by: call.body.by ?? "",
        ...(call.body.note ? { note: call.body.note } : {}),
      }),
  }),
  route({
    method: "POST",
    pattern: "/system/plans/:plan/approve",
    body: body({ by: text }),
    guard: personOnly,
    handler: (call) => call.c.resolve("systemPlans").approve(plan(call), call.body.by ?? ""),
  }),
];
