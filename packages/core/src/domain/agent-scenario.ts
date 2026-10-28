import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * A scripted stand-in for an AI host (F8.3): what each agent "does" when the drive starts it,
 * so a whole run can be driven end to end without a model (tests, demos, CI of workflows).
 * The n-th start of an agent plays its n-th entry; the last entry repeats.
 */
const Step = z.union([
  z.strictObject({ say: z.string() }),
  z.strictObject({ write: z.strictObject({ path: z.string().min(1), text: z.string() }) }),
  z.strictObject({ tool: z.strictObject({ name: z.string().min(1), summary: z.string() }) }),
  z.strictObject({
    ask: z.strictObject({
      question: z.string().min(1),
      options: z.array(z.string().min(1)).min(1),
      multiSelect: z.boolean().default(false),
    }),
  }),
  z.strictObject({ fail: z.string().min(1) }),
]);

export const AgentScenarioSchema = z.strictObject({
  agents: z.record(z.string().min(1), z.array(z.array(Step).min(1)).min(1)),
});
export type AgentScenario = z.output<typeof AgentScenarioSchema>;
export type ScenarioStep = AgentScenario["agents"][string][number][number];

export const AgentScenarioDocument = defineDocument("AgentScenario", {
  latest: AgentScenarioSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Each agent lists its starts; each start lists steps: say, write, tool, ask or fail.",
});

/** `{runDir}` and `{cwd}` in a scenario path or text, filled in for this start. */
export function fillScenario(text: string, vars: { readonly runDir: string; readonly cwd: string }): string {
  return text.replaceAll("{runDir}", vars.runDir).replaceAll("{cwd}", vars.cwd);
}
