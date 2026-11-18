import { z } from "zod";
import { body, type Call, denied, type Route, route, text } from "../http.ts";

/**
 * `/runs/:run/plan` and `/system/plans`: plans a person reads, lints and approves in the app. A
 * person does not edit a plan: they ask for changes at its approval gate, and its planner revises
 * it (ADR-0089); the view shows the version it replaced and what changed.
 */

/** A plan is approved by a person in the app; an agent's pane writes its files where its stage says. */
export async function personOnly({ token }: Call): Promise<ReturnType<typeof denied> | undefined> {
  return token
    ? denied(
        "a plan is approved by a person in the app, not from a pane",
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
    method: "POST",
    pattern: "/system/plans/:plan/approve",
    body: body({ by: text }),
    guard: personOnly,
    handler: (call) => call.c.resolve("systemPlans").approve(plan(call), call.body.by ?? ""),
  }),
];
