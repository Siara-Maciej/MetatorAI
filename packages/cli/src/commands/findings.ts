import {
  DEFAULT_LENSES,
  err,
  FindingSetDocument,
  LENSES,
  MetatorError,
  normalizePath,
  ok,
} from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerFindingsCommands(program: Command, { action, container }: CommandContext): void {
  const findings = program
    .command("findings")
    .description("Review findings: validate against the code, merge across lenses");

  findings
    .command("validate")
    .description(
      "Schema, policy (blocking needs trigger, reachability, evidence) and quotes checked against the code",
    )
    .argument("<dir>", "directory of FindingSet JSON files, e.g. .metator/runs/<id>/findings")
    .option("--fix", "rewrite the line of findings whose quote moved", false)
    .action(
      action(async (dir: string, opts: { fix: boolean }) => {
        const report = await container()
          .resolve("validateFindings")
          .execute({ dir: normalizePath(dir), fix: opts.fix });
        if (report.isErr()) return { result: report };
        const { invalid, moved } = report.value.counts;
        const unreadable = report.value.unreadable.length;
        if (invalid + moved + unreadable > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${invalid} invalid, ${moved} moved, ${unreadable} unreadable`,
                {
                  hint: "Invalid findings never reach Verify: fix the quote or the missing fields; `--fix` updates moved lines.",
                  details: { ...report.value },
                },
              ),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  findings
    .command("check-quote")
    .description("One quote against one file near a line (normalized whitespace); moved or missing fails")
    .argument("<file>", "file the quote is claimed to be in")
    .requiredOption("--line <n>", "line the quote is claimed to be on", positiveInt)
    .requiredOption("--quote <text>", "the quoted code")
    .action(
      action(async (file: string, opts: { line: number; quote: string }) => {
        const match = await container()
          .resolve("checkQuote")
          .execute({ file: normalizePath(file), line: opts.line, quote: opts.quote });
        if (match.isErr() || match.value.status === "ok") return { result: match };
        const m = match.value;
        return {
          result: err(
            new MetatorError(
              "CHECK_FAILED",
              m.status === "moved"
                ? `quote is on line ${m.line} of ${m.file}, not ${opts.line}`
                : `quote not found in ${m.file}`,
              {
                hint: "A finding must quote the code it is about; fix the line or the quote.",
                details: { ...m },
              },
            ),
          ),
        };
      }),
    );

  findings
    .command("merge")
    .description("Drop invalid findings and merge duplicates across lenses into <dir>/merged.json")
    .argument("<dir>", "directory of FindingSet JSON files")
    .action(
      action(async (dir: string) => ({
        result: await container()
          .resolve("mergeFindings")
          .execute({ dir: normalizePath(dir) }),
      })),
    );

  findings
    .command("verdict")
    .description(
      "Decision from merged findings: only confirmed blockers block; unverified blockers mean not decided",
    )
    .argument("<dir>", "directory with merged.json")
    .option("--verified-correct <areas...>", "areas the reviewers checked and found correct")
    .action(
      action(async (dir: string, opts: { verifiedCorrect?: string[] }) => ({
        result: await container()
          .resolve("judgeFindings")
          .execute({ dir: normalizePath(dir), verifiedCorrect: opts.verifiedCorrect ?? [] }),
      })),
    );

  findings
    .command("to-github")
    .description(
      "Inline comments (confirmed blockers only) and a summary from verdict.json, for posting after approval",
    )
    .argument("<verdict>", "path to verdict.json")
    .addOption(
      new Option("--format <format>", "comment style").choices(["natural", "labeled"]).default("labeled"),
    )
    .addOption(
      new Option("--role <role>", "reviewer: inline comments; author (own PR): a fix list, no comments")
        .choices(["reviewer", "author"])
        .default("reviewer"),
    )
    .action(
      action(
        async (verdict: string, opts: { format: "natural" | "labeled"; role: "reviewer" | "author" }) => ({
          result: await container()
            .resolve("formatReviewComments")
            .execute({ verdict: normalizePath(verdict), format: opts.format, role: opts.role }),
        }),
      ),
    );

  findings
    .command("schema")
    .description("Print the JSON Schema of a findings file")
    .action(action(() => ({ result: ok(FindingSetDocument.jsonSchema("input")) })));
}

export function registerReviewCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("review")
    .description("Plan a review of the change")
    .command("plan")
    .description("Shards per package with card and rules; lenses run per shard")
    .option("--base <ref>", "review files changed against this ref", "HEAD")
    .option("--files <files...>", "review these files instead")
    .addOption(
      new Option("--lenses <lenses...>", "lenses to run").choices([...LENSES]).default([...DEFAULT_LENSES]),
    )
    .option("--max-files <n>", "files per shard", positiveInt, 15)
    .option("--out <path>", "also write the plan as a ReviewPlan document")
    .action(
      action(
        async (opts: {
          base: string;
          files?: string[];
          lenses: (typeof LENSES)[number][];
          maxFiles: number;
          out?: string;
        }) => ({
          result: await container()
            .resolve("planReview")
            .execute({
              ...(opts.files ? { files: opts.files.map((f) => normalizePath(f)) } : { base: opts.base }),
              lenses: opts.lenses,
              maxFiles: opts.maxFiles,
              ...(opts.out ? { out: normalizePath(opts.out) } : {}),
            }),
        }),
      ),
    );
}
