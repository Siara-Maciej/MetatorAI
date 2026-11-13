import {
  DEFAULT_LENSES,
  err,
  FindingSetDocument,
  type FindingSeverity,
  LENSES,
  MetatorError,
  normalizePath,
  ok,
  REACTION_STATES,
  type ReactionState,
  SEVERITIES,
} from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { byOption, defined, positiveInt, runOption } from "../options.ts";
import { schemaCommand } from "../outcome.ts";
import { asPerson } from "../who.ts";

type Lens = (typeof LENSES)[number];

interface CalibrateOptions {
  readonly id: string;
  readonly severity?: string;
  readonly merge?: string[];
  readonly trigger?: string;
  readonly reachability?: string;
  readonly evidence?: string;
}

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
    .option("--plan <file>", "review-plan.json: fail when a lens wrote no file for a shard")
    .action(
      action(async (dir: string, opts: { fix: boolean; plan?: string }) => {
        const report = await container()
          .resolve("validateFindings")
          .execute({
            dir: normalizePath(dir),
            fix: opts.fix,
            ...(opts.plan ? { plan: normalizePath(opts.plan) } : {}),
          });
        if (report.isErr()) return { result: report };
        const { invalid, moved } = report.value.counts;
        const unreadable = report.value.unreadable.length;
        const missing = report.value.missing.length;
        if (invalid + moved + unreadable + missing > 0) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${invalid} invalid, ${moved} moved, ${unreadable} unreadable, ${missing} missing`,
                {
                  hint: missing
                    ? `No findings file from: ${report.value.missing.join(", ")}. Each lens writes one per shard, with \`findings: []\` when it found nothing.`
                    : "Invalid findings never reach Verify: fix the quote or the missing fields; `--fix` updates moved lines.",
                  details: { ...report.value },
                },
              ),
            ),
          };
        }
        return { result: ok(report.value) };
      }),
    );

  meta(findings.command("check-quote"), { reads: true })
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
    .command("calibrate")
    .description(
      "The judge's calibration of <dir>/merged.json: one finding's severity, and the findings with the same root cause folded into it",
    )
    .argument("<dir>", "directory with merged.json")
    .requiredOption("--id <id>", "the finding to calibrate")
    .option("--severity <severity>", `new severity: ${SEVERITIES.join(", ")}`)
    .option(
      "--merge <ids...>",
      "findings with the same root cause, folded into it (their lenses join alsoFrom)",
    )
    .option("--trigger <text>", "the input or state that triggers it (a blocker needs one)")
    .option("--reachability <text>", "the path from a real caller (a blocker needs one)")
    .option("--evidence <type:ref>", "test, trace, rule or doc, then the reference (a blocker needs one)")
    .action(
      action(async (dir: string, opts: CalibrateOptions) => {
        if (opts.severity && !(SEVERITIES as readonly string[]).includes(opts.severity))
          return {
            result: err(
              MetatorError.usage(
                `unknown severity ${opts.severity}`,
                `Use one of: ${SEVERITIES.join(", ")}.`,
              ),
            ),
          };
        const evidence = opts.evidence ? /^(test|trace|rule|doc):(.+)$/.exec(opts.evidence) : null;
        if (opts.evidence && !evidence)
          return {
            result: err(
              MetatorError.usage(
                `invalid --evidence ${opts.evidence}`,
                "Use <test|trace|rule|doc>:<reference>.",
              ),
            ),
          };
        return {
          result: await container()
            .resolve("calibrateFinding")
            .execute({
              dir: normalizePath(dir),
              id: opts.id,
              ...(opts.severity ? { severity: opts.severity as FindingSeverity } : {}),
              ...(opts.merge ? { merge: opts.merge } : {}),
              ...(opts.trigger ? { trigger: opts.trigger } : {}),
              ...(opts.reachability ? { reachability: opts.reachability } : {}),
              ...(evidence
                ? {
                    evidence: {
                      type: evidence[1] as "test" | "trace" | "rule" | "doc",
                      ref: evidence[2] as string,
                    },
                  }
                : {}),
            }),
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

  meta(findings.command("to-github"), { audience: "person" })
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

  schemaCommand(findings, { action }, "Print the JSON Schema of a findings file", FindingSetDocument);
  findings
    .command("react")
    .description(
      "Record what happened to a review comment on a PR: resolved (fixed), dismissed (noise) or open (F5 telemetry)",
    )
    .argument("<finding>", "the finding id the comment carried (LOGIC-007)")
    .requiredOption("--pr <ref>", "the pull request (42, owner/repo#42)")
    .addOption(
      new Option("--state <state>", "what people did with it")
        .choices([...REACTION_STATES])
        .makeOptionMandatory(),
    )
    .addOption(byOption("who reacted"))
    .addOption(new Option("--lens <lens>", "the lens that raised it").choices([...LENSES]))
    .option("--reason <text>", "why, in a few words")
    .action(
      action(
        async (
          finding: string,
          opts: { pr: string; state: ReactionState; by?: string; lens?: Lens; reason?: string },
        ) =>
          asPerson(container(), opts.by, async (by) => ({
            result: await container()
              .resolve("reviewFeedback")
              .record({
                finding,
                pr: opts.pr,
                state: opts.state,
                by,
                ...defined({ lens: opts.lens, reason: opts.reason }),
              }),
          })),
      ),
    );
}

export function registerReviewCommands(program: Command, { action, container, runs }: CommandContext): void {
  const review = program.command("review").description("Plan a review of the change and describe it");
  meta(review.command("metadata"), { reads: true, writesWith: ["--out"] })
    .description("The branch against its base: commits, authors, changed files, uncommitted work (pr.json)")
    .option("--base <ref>", "the branch the change goes into", "HEAD")
    .option("--out <path>", "also write it as a ReviewMetadata document")
    .action(
      action(async (opts: { base: string; out?: string }) => ({
        result: await container()
          .resolve("describeReviewedChange")
          .execute({ base: opts.base, ...(opts.out ? { out: normalizePath(opts.out) } : {}) }),
      })),
    );
  meta(review.command("diff"), { reads: true, writesWith: ["--out"] })
    .description("The change as a unified diff (new files whole), without MetatorAI's own files")
    .argument("[files...]", "only these files")
    .option("--base <ref>", "the branch the change goes into", "HEAD")
    .option("--out <path>", "write the patch to this file as plain text (read it with your Read tool)")
    .action(
      action(async (files: string[], opts: { base: string; out?: string }) => ({
        result: await container()
          .resolve("showChangeDiff")
          .execute({
            base: opts.base,
            ...(files.length > 0 ? { files: files.map(normalizePath) } : {}),
            ...(opts.out ? { out: normalizePath(opts.out) } : {}),
          }),
      })),
    );
  // The change of a run and a person's notes on it (S5, design/13 §5).
  meta(review.command("changes"), { audience: "person" })
    .description("The files a run changed, with their line counts; --file adds that file's diff as hunks")
    .addOption(runOption())
    .option("--file <path>", "one file's diff, as hunks and numbered lines")
    .action(
      action(async (opts: { run?: string; file?: string }) => ({
        result: await runs()
          .resolve("runChanges")
          .execute({ ...(opts.run ? { runId: opts.run } : {}), ...(opts.file ? { file: opts.file } : {}) }),
      })),
    );
  const notes = review
    .command("notes")
    .description("A person's notes on a run's change, sent to its agents as one message");
  notes
    .command("list")
    .description("The notes with their status (draft, sent, addressed)")
    .addOption(runOption())
    .action(
      action(async (opts: { run?: string }) => ({
        result: await runs().resolve("reviewNotes").list(opts.run),
      })),
    );
  meta(notes.command("add"), { audience: "person" })
    .description("A note on a file and line (or on the whole change); it waits as a draft until `notes send`")
    .argument("<text>", "the note")
    .addOption(runOption())
    .option("--file <path>", "the file it is about (repo-relative)")
    .option("--line <n>", "the line in it", positiveInt)
    .addOption(new Option("--side <side>", "the old or the new side of the diff").choices(["old", "new"]))
    .addOption(byOption("who writes it"))
    .action(
      action(
        async (
          text: string,
          opts: { run?: string; file?: string; line?: number; side?: "old" | "new"; by?: string },
        ) =>
          asPerson(runs(), opts.by, async (by) => ({
            result: await runs()
              .resolve("reviewNotes")
              .add(opts.run, { text, by, ...defined({ file: opts.file, line: opts.line, side: opts.side }) }),
          })),
      ),
    );
  notes
    .command("send")
    .description("The draft notes go to the run's agents as one message (topic review)")
    .addOption(runOption())
    .addOption(byOption("who sends"))
    .action(
      action(async (opts: { run?: string; by?: string }) =>
        asPerson(runs(), opts.by, async (by) => ({
          result: await runs().resolve("reviewNotes").send(opts.run, { by }),
        })),
      ),
    );
  notes
    .command("status")
    .description("Mark a note addressed, or reopen it as a draft")
    .argument("<id>", "the note id (n001)")
    .addOption(
      new Option("--set <status>", "the new status")
        .choices(["draft", "sent", "addressed"])
        .default("addressed"),
    )
    .addOption(runOption())
    .action(
      action(async (id: string, opts: { run?: string; set: "draft" | "sent" | "addressed" }) => ({
        result: await runs().resolve("reviewNotes").setStatus(opts.run, id, opts.set),
      })),
    );
  meta(review.command("plan"), { audience: "person", reads: true, writesWith: ["--out"] })
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
