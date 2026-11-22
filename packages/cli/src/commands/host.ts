import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_DIR,
  type ConformanceCheckResult,
  diffConformance,
  err,
  type HostConformance,
  MetatorError,
  ok,
  readConformance,
} from "@metator/core";
import { type Command, InvalidArgumentError, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { nonNegativeInt, positiveInt } from "../options.ts";
import { renderConformanceDiff, renderConformanceRun } from "../render.ts";

/** The hosts the suite drives: the two the decision names first, then the others that run in a pane. */
const CONFORMANCE_HOSTS = ["claude", "copilot", "opencode", "scenario"] as const;

/** `--only start,resume`: the checks by id, checked against the suite's own list. */
function checkIds(value: string, previous: readonly string[] = []): string[] {
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !CONFORMANCE_CHECK_IDS.includes(id));
  if (unknown.length > 0)
    throw new InvalidArgumentError(
      `no such check: ${unknown.join(", ")} (the checks: ${CONFORMANCE_CHECK_IDS.join(", ")})`,
    );
  return [...previous, ...ids];
}

/**
 * `host` (ADR-0098): the AI hosts MetatorAI drives. `host conformance` runs the same checks against
 * one host's real CLI in a throwaway repository (never in tests or CI: `METATOR_NO_REAL_HOSTS`
 * refuses it); `host conformance diff` lists the checks two runs disagree on, the parity gaps.
 */
export function registerHostCommands(program: Command, ctx: CommandContext): void {
  const host = program
    .command("host")
    .description("The AI hosts MetatorAI drives: one conformance suite for Claude Code and Copilot CLI");

  const conformance = meta(host.command("conformance"), {
    audience: "person",
    render: renderConformanceRun,
  })
    .description(
      "Run the host conformance suite against a host's real CLI: a fresh repository, its daemon, the same checks for every host; a report to send back",
    )
    .addOption(new Option("--host <host>", "the host whose real CLI is driven").choices(CONFORMANCE_HOSTS))
    .option(
      "--only <ids>",
      `only these checks, comma-separated: ${CONFORMANCE_CHECK_IDS.join(", ")}`,
      checkIds,
    )
    .option("--out <dir>", `where the report goes (default: ${CONFORMANCE_DIR})`)
    .option("--keep", "keep the throwaway repository (and its daemon's log) for a look afterwards", false)
    .option("--timeout <seconds>", "how long one check may take", positiveInt, 180)
    .option(
      "--settle <ms>",
      "how long the session stays idle at its prompt before its turn counts as over",
      nonNegativeInt,
      4000,
    )
    .action(
      ctx.action(
        async (opts: {
          host?: (typeof CONFORMANCE_HOSTS)[number];
          only?: string[];
          out?: string;
          keep: boolean;
          timeout: number;
          settle: number;
        }) => {
          if (!opts.host)
            return {
              result: err(
                MetatorError.usage(
                  "name the host: --host claude|copilot",
                  "`metator host conformance diff <a.json> <b.json>` compares two runs.",
                ),
              ),
            };
          const run = await ctx
            .container()
            .resolve("runHostConformance")
            .execute({
              host: opts.host,
              ...(opts.only ? { only: opts.only } : {}),
              ...(opts.out ? { out: opts.out } : {}),
              keep: opts.keep,
              timeoutMs: opts.timeout * 1000,
              settleMs: opts.settle,
              // A quick host is looked at more often: twice within the time it must stay at rest.
              pollMs: Math.min(1000, Math.max(100, Math.round(opts.settle / 2))),
              ...(ctx.terminal ? { progress: (line: string) => ctx.terminal?.show(line) } : {}),
            });
          if (run.isErr()) return { result: run };
          const failed = run.value.document.checks.filter((c) => c.result === "fail");
          return {
            result: ok({
              host: run.value.document.host,
              cliVersion: run.value.document.cliVersion,
              passed: run.value.passed,
              failed: run.value.failed,
              skipped: run.value.skipped,
              report: run.value.files.json,
              rendered: run.value.files.report,
              ...(run.value.kept ? { kept: run.value.kept } : {}),
              checks: run.value.document.checks.map(brief),
            }),
            warnings: failed.map((c) => `${c.id} did not pass: ${c.evidence.split("\n").at(-1) ?? ""}`),
          };
        },
      ),
    );

  meta(conformance.command("diff"), { audience: "person", render: renderConformanceDiff })
    .description("The checks whose result differs between two runs of the suite (two hosts): the parity gaps")
    .argument("<a>", "a run's report (conformance-<host>-<version>.json)")
    .argument("<b>", "the other run's report")
    .action(
      ctx.action(async (a: string, b: string) => {
        const read = (file: string) => {
          const path = isAbsolute(file) ? file : join(ctx.start(), file);
          try {
            return readConformance(readFileSync(path, "utf8"), file);
          } catch (e) {
            return err(MetatorError.notFound(`report ${file}`, { hint: (e as Error).message }));
          }
        };
        const [x, y] = [read(a), read(b)];
        if (x.isErr()) return { result: x };
        if (y.isErr()) return { result: y };
        const differ = diffConformance(x.value, y.value);
        return {
          result: ok({
            a: side(x.value),
            b: side(y.value),
            differ,
            same:
              CONFORMANCE_CHECK_IDS.length -
              differ.filter((d) => CONFORMANCE_CHECK_IDS.includes(d.id)).length,
          }),
        };
      }),
    );
}

const side = (d: HostConformance) => ({ host: d.host, cliVersion: d.cliVersion, endedAt: d.endedAt });

/** A check as the command's answer gives it: its result and the last line of its evidence. */
const brief = (c: ConformanceCheckResult) => ({
  id: c.id,
  result: c.result,
  tookMs: c.tookMs,
  last: c.evidence.split("\n").at(-1) ?? "",
});
