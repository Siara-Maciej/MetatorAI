import { quote } from "shell-quote";
import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Where a run's host session lives in herdr (E2, ADR-0079): `.metator/runs/<id>/herdr.json`.
 * herdr owns the terminal; MetatorAI keeps only the address, to find the session again.
 */
export const HerdrBindingSchema = z.strictObject({
  /** herdr's workspace and pane ids (`w3`, `w3:p1`). */
  workspace: z.string().min(1),
  pane: z.string().min(1),
  /** The InteractiveHost that runs there, and its session id (to resume it). */
  host: z.string().min(1),
  sessionId: z.string().min(1),
  openedAt: z.iso.datetime(),
});
export type HerdrBinding = z.output<typeof HerdrBindingSchema>;

export const HerdrBindingDocument = defineDocument("HerdrBinding", {
  latest: HerdrBindingSchema,
  hint: "Written by `metator herdr open`; removed by `metator herdr close`.",
});

export const HerdrWorkspaceSchema = z.strictObject({
  /** herdr's session (`HERDR_SESSION`, `default` when unset) and its workspace id there. */
  session: z.string().min(1),
  workspace: z.string().min(1),
  /** Absolute repository root and the run the workspace belongs to. */
  root: z.string().min(1),
  runId: z.string().min(1),
});
export type HerdrWorkspace = z.output<typeof HerdrWorkspaceSchema>;

/**
 * Which repository and run each herdr workspace MetatorAI opened belongs to, machine-wide
 * (`herdr-workspaces.json` in the machine's state directory): herdr's plugin actions know only
 * the workspace id, and find the run from it.
 */
export const HerdrWorkspacesDocument = defineDocument("HerdrWorkspaces", {
  latest: z.strictObject({ entries: z.array(HerdrWorkspaceSchema) }),
  hint: "Written by `metator herdr open` and `metator herdr close`.",
});

/** A command line herdr types into its pane's shell: every argument quoted for a POSIX shell. */
export const shellLine = (argv: readonly string[]): string => quote([...argv]);

/** The run's place in herdr's sidebar: stage and who must act, from the overview. */
export function herdrTitle(run: {
  readonly stage: string;
  readonly attention: string;
  readonly questions: number;
}): string {
  const who =
    run.attention === "you"
      ? run.questions > 0
        ? `waits for you (${run.questions})`
        : "waits for you"
      : run.attention === "driving"
        ? "working"
        : run.attention;
  return `${run.stage} · ${who}`;
}
