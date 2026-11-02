import { z } from "zod";
import type { Question } from "./drive.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Answer policies (P5): "always X for Y", remembered from a person's answer and kept in the
 * repository (`metator/answer-policies.yml`), so the team reviews them like code. A policy answers
 * a question the moment it is asked, under its own name, and never where a wrong answer costs
 * more than a question: it never approves what cannot be taken back (the push), and never allows
 * a tool (a policy may only deny one).
 */
export const AnswerPolicySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  when: z.strictObject({
    source: z.enum(["gate", "agent", "permission"]),
    /** The stage id; omitted: any stage. */
    stage: z.string().min(1).optional(),
    /** The agent that asks; omitted: any agent. */
    agent: z.string().min(1).optional(),
    /** Only when the decision card recommends this option (e.g. a gate whose stage before passed). */
    recommended: z.string().min(1).optional(),
    /** Only when the question's prompt contains this text (a command, a file). */
    promptIncludes: z.string().min(1).optional(),
  }),
  answer: z.strictObject({
    choices: z.array(z.string().min(1)).min(1),
    text: z.string().min(1).optional(),
  }),
  /** Who decided it, and when. */
  by: z.string().min(1),
  at: z.iso.datetime(),
});
export type AnswerPolicy = z.output<typeof AnswerPolicySchema>;

export const AnswerPoliciesDocument = defineDocument("AnswerPolicies", {
  latest: z.strictObject({ policies: z.array(AnswerPolicySchema) }),
  hint: "Add one with `metator run answer <q> --choice <label> --by <name> --always`; remove with `metator policy rm <id>`.",
});

/** Why a policy may not answer such a question, or undefined when it may. */
export function policyRefusal(
  q: Pick<Question, "source" | "card">,
  choices: readonly string[],
): string | undefined {
  if (q.source === "permission" && !choices.every((c) => c === "Deny"))
    return "a policy may deny a tool, never allow one: allowing stays a person's decision each time";
  if (q.card && !q.card.reversible)
    return "this decision cannot be taken back (a push, closing a run): it stays a person's each time";
  if (choices.includes("Other") || choices.includes("Reject"))
    return "a policy gives a fixed answer: Other and Reject need a person's own words each time";
  return undefined;
}

/** The first policy that answers this question, when one does and is allowed to. */
export function matchPolicy(
  policies: readonly AnswerPolicy[],
  q: Pick<Question, "source" | "stage" | "agent" | "prompt" | "card" | "options">,
): AnswerPolicy | undefined {
  const labels = new Set(q.options.map((o) => o.label));
  return policies.find(
    (p) =>
      p.when.source === q.source &&
      (p.when.stage === undefined || p.when.stage === q.stage) &&
      (p.when.agent === undefined || p.when.agent === q.agent) &&
      (p.when.recommended === undefined || p.when.recommended === q.card?.recommended) &&
      (p.when.promptIncludes === undefined || q.prompt.includes(p.when.promptIncludes)) &&
      p.answer.choices.every((c) => labels.has(c)) &&
      policyRefusal(q, p.answer.choices) === undefined,
  );
}

/** The policy a person's answer makes: the same question, from where it came, answered the same. */
export function policyFrom(
  q: Pick<Question, "source" | "stage" | "agent" | "card">,
  answer: { readonly choices: readonly string[]; readonly text?: string },
  by: string,
  at: string,
  taken: readonly string[],
): AnswerPolicy {
  const base = `${q.source}-${q.stage}-${answer.choices.join("-")}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return {
    id,
    when: {
      source: q.source,
      stage: q.stage,
      ...(q.agent ? { agent: q.agent } : {}),
      ...(q.card?.recommended ? { recommended: q.card.recommended } : {}),
    },
    answer: { choices: [...answer.choices], ...(answer.text ? { text: answer.text } : {}) },
    by,
    at,
  };
}
