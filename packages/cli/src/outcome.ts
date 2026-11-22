import { err, MetatorError, ok, type Result } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext, Outcome } from "./context.ts";

export interface Failure {
  readonly message: string;
  readonly hint?: string;
}

/**
 * A check's report as the command's outcome: CHECK_FAILED (exit 1) with the whole report in
 * `details` when `problem` names one, else the report itself. An error of the use case passes through.
 */
export function failWhen<T extends object>(
  report: Result<T, MetatorError>,
  problem: (value: T) => Failure | undefined | false,
  warnings: (value: T) => readonly string[] = () => [],
): Outcome {
  if (report.isErr()) return { result: report };
  const said = warnings(report.value);
  const extra = said.length > 0 ? { warnings: said } : {};
  const failure = problem(report.value);
  if (!failure) return { result: report, ...extra };
  return {
    result: err(
      new MetatorError("CHECK_FAILED", failure.message, {
        ...(failure.hint ? { hint: failure.hint } : {}),
        details: { ...report.value } as Record<string, unknown>,
      }),
    ),
    ...extra,
  };
}

/** `<group> schema`: prints the JSON Schema of the document the group works on. */
export function schemaCommand(
  group: Command,
  { action }: Pick<CommandContext, "action">,
  description: string,
  document: { jsonSchema(io: "input"): unknown },
  name = "schema",
): Command {
  return group
    .command(name)
    .description(description)
    .action(action(() => ({ result: ok(document.jsonSchema("input")) })));
}
