/**
 * Home's queue of decisions: what a card says, how it is answered, what Home says when nothing waits.
 */

import type { PlanLintView, Question, RunOverview } from "../../shared/api/api.ts";
import { plural } from "../../shared/model/format.ts";
import { blockedReason } from "../../shared/model/look.ts";
import { parseRoute, type Route } from "../../shared/model/route.ts";

/**
 * Whether the card shows the task under Goal: only when its title does not already carry the
 * whole task (a gate's title names the task; a long or multi-line one is cut there).
 */
export const goalShown = (prompt: string, task: string): boolean => !prompt.includes(task.trim());
/**
 * The stages the ESCALATED card offers a resume at: what the daemon says the run already worked,
 * and always the stage it escalated from (an older daemon names none).
 */
export function resumeStages(run: Pick<RunOverview, "stage" | "resumable">): string[] {
  const listed = run.resumable ?? [];
  return listed.includes(run.stage) ? [...listed] : [...listed, run.stage];
}
/** What Resume will do, in one sentence: in place with fresh tries, or back to an earlier stage. */
export function resumePlan(stage: string, to: string): string {
  return to === stage
    ? `the run goes back to ${stage} with a fresh set of tries and is driven on`
    : `the run goes back to ${to} and works from there to ${stage} again; approvals on the way are asked again`;
}
/** What the app says after Resume: the run is driven again, or why no drive started. */
export function resumeNotice(
  runId: string,
  drive: { readonly started?: boolean; readonly error?: string; readonly hint?: string } | undefined,
): string | undefined {
  if (!drive?.error) return undefined;
  return `Run ${runId} is resumed, but no agent works on it: ${drive.error}${drive.hint ? ` ${drive.hint}` : ""}`;
}
/**
 * The command the card's footer shows: what the button does. The card answers the question
 * (`POST /runs/:id/answer`), a gate's question too, so the command is `run answer` for every source.
 */
export function answerCommand(
  q: Pick<Question, "id" | "runId">,
  choice: string | readonly string[],
  by: string,
  text = "",
): string {
  const who = by ? quote(by) : "<you>";
  const choices = (typeof choice === "string" ? [choice] : choice).map(quote).join(" ");
  const words = text.trim() ? ` --text ${quote(text.trim())}` : "";
  return `metator run answer ${q.id} --run ${q.runId} --choice ${choices || "…"}${words} --by ${who}`;
}
const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
/** The choices after a click on one (D8): a multi-select question toggles it, any other takes it alone. */
export const toggleChoice = (selected: readonly string[], label: string, multi: boolean): string[] =>
  !multi ? [label] : selected.includes(label) ? selected.filter((c) => c !== label) : [...selected, label];
/** Reject and Other promise the person's own words: the answer waits for them. */
export const needsReason = (choices: readonly string[]): boolean =>
  choices.some((c) => c === "Reject" || c === "Other");
/** Whether an answer can be sent: something is chosen, and the reason is there when one is promised. */
export const canAnswer = (choices: readonly string[], text: string): boolean =>
  choices.length > 0 && (!needsReason(choices) || text.trim() !== "");
/** Nothing has ever been started here: the app offers to describe a task instead of an empty queue. */
export const isFirstRun = (runs: readonly unknown[], needs: readonly unknown[]): boolean =>
  runs.length === 0 && needs.length === 0;
/**
 * What the Inbox says when no decision waits: true words about the runs that are open. A run with
 * nothing driving it, or a blocked task, is something for the person to look at: then it never
 * says "nothing".
 */
export function quietInboxText(open: number, idle: number, blocked = 0): string {
  if (idle > 0)
    return `${plural(idle, "run")} ${idle === 1 ? "has" : "have"} no agent working on ${idle === 1 ? "it" : "them"}:`;
  if (blocked > 0)
    return `${plural(blocked, "task")} ${blocked === 1 ? "is" : "are"} blocked without a question: what each needs is under it.`;
  if (open === 0) return "No run is open. Open a finished run from the sidebar, or start a new one.";
  return `Nothing needs you. ${plural(open, "run")} ${open === 1 ? "is" : "are"} working.`;
}
/** Home's heading when no decision waits: "nothing" only when nothing stands still either. */
export const quietHeading = (idle: number, blocked: number): string =>
  idle + blocked > 0 ? "No decision waits for you" : "Nothing waits for you";
/** What a blocked task needs, in Home's list: why its run stands still, the way out with it. */
export const taskNeed = (run: Pick<RunOverview, "status" | "stage" | "reason"> | undefined): string =>
  blockedReason({ run });
/**
 * Why an option of a card cannot be chosen now, or nothing. The daemon closes an option itself
 * (`disabled`, `disabledBecause`: Approve on a plan whose lint has errors); for a card read before
 * it did, the plan's own lint closes Approve the same way.
 */
export function optionClosed(
  option: { readonly label: string },
  planLint?: Pick<PlanLintView, "problems"> | undefined,
): string | undefined {
  const o = option as {
    readonly label: string;
    readonly disabled?: boolean;
    readonly disabledBecause?: string;
  };
  if (o.disabled === true) return o.disabledBecause ?? "the daemon closed this answer";
  if (o.label !== "Approve" || !planLint) return undefined;
  const errors = planLint.problems.filter((p) => p.severity === "error");
  if (errors.length === 0) return undefined;
  return `the plan has ${plural(errors.length, "error")}: ${errors[0]?.message ?? ""}`;
}

/**
 * Where Home goes once a card's answer is through: back to its queue, but only while the person is
 * still on Home. The daemon's answer can come late (a loaded machine); a person who went elsewhere
 * meanwhile stays where they went.
 */
export function afterAnswer(hash: string): Route | undefined {
  return parseRoute(hash).screen === "inbox" ? { screen: "inbox" } : undefined;
}
