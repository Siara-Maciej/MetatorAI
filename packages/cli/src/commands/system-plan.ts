import {
  err,
  MetatorError,
  ok,
  SystemAnalysisDocument,
  SystemPlanDocument,
  systemPlanWaves,
} from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { person } from "../live.ts";
import { defaultHost, HOSTS } from "../sessions.ts";

interface AnalyzeOptions {
  base: string;
  files?: string[];
  contracts?: string[];
  breaking?: string[];
}

const analyzeInput = (task: string[], opts: AnalyzeOptions) => ({
  task: task.join(" "),
  ...(opts.files ? { files: opts.files } : { base: opts.base }),
  ...(opts.contracts ? { contracts: opts.contracts } : {}),
  ...(opts.breaking ? { breaking: opts.breaking } : {}),
});

const withAnalyzeOptions = (c: Command) =>
  c
    .option("--base <ref>", "the files changed since the merge base with this ref", "HEAD")
    .option("--files <files...>", "these files instead of git")
    .option("--contracts <ids...>", "contracts the task changes")
    .option("--breaking <ids...>", "contracts the task changes in a breaking way");

/** `system analyze` and `system plan` (F7.5): a change across the system, planned and approved. */
export function registerSystemPlanCommands(system: Command, ctx: CommandContext): void {
  const { action, container, terminal } = ctx;

  withAnalyzeOptions(
    system
      .command("analyze")
      .description("What a task touches across the system: contracts, breaking or not, consumers, owners")
      .argument("<task...>", "the task"),
  ).action(
    action(async (task: string[], opts: AnalyzeOptions) => ({
      result: await container().resolve("analyzeSystem").execute(analyzeInput(task, opts)),
    })),
  );

  const plan = system
    .command("plan")
    .description("System plans: steps per application in deploy order, linted and approved by a person");

  withAnalyzeOptions(
    plan
      .command("new")
      .description("Draft a plan from the task's analysis, by the map's breaking and deploy policies")
      .argument("<task...>", "the task"),
  ).action(
    action(async (task: string[], opts: AnalyzeOptions) => ({
      result: await container()
        .resolve("createSystemPlan")
        .execute({ ...analyzeInput(task, opts), by: person(process.env) }),
    })),
  );

  withAnalyzeOptions(
    plan
      .command("propose")
      .description("mt-system-scout checks the analysis and mt-system-planner refines the plan; then lint")
      .argument("<task...>", "the task")
      .option("--host <host>", `the AI host that plans: ${HOSTS.join(", ")}`),
  ).action(
    action(async (task: string[], opts: AnalyzeOptions & { host?: string }) => {
      const c = container();
      const root = c.resolve("root");
      const t = terminal;
      const r = await c.resolve("proposeSystemPlan").execute({
        ...analyzeInput(task, opts),
        host: opts.host ?? defaultHost(c),
        by: person(process.env),
        cwd: root,
        projectRoot: root,
        ...(t
          ? {
              onEvent: (e) => {
                if (e.type === "text") t.show(e.text);
                else if (e.type === "tool") t.show(`· ${e.name} ${e.summary}`);
              },
            }
          : {}),
      });
      return {
        result: r,
        warnings: r.isOk() ? r.value.problems.map((p) => `${p.step ? `${p.step}: ` : ""}${p.message}`) : [],
      };
    }),
  );

  plan
    .command("list")
    .description("Every system plan with its status and steps")
    .action(
      action(async () => ({
        result: (await container().resolve("systemPlanStore").list()).map((plans) => ({
          plans: plans.map((p) => ({
            id: p.id,
            task: p.task,
            status: p.status,
            steps: p.steps.length,
            done: p.steps.filter((s) => s.status === "done").length,
          })),
        })),
      })),
    );

  plan
    .command("show")
    .description("One system plan with its waves and its analysis")
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => {
        const store = container().resolve("systemPlanStore");
        const p = await store.load(id);
        if (p.isErr()) return { result: p };
        const analysis = await store.loadAnalysis(id);
        if (analysis.isErr()) return { result: analysis };
        return {
          result: ok({
            plan: p.value,
            waves: systemPlanWaves(p.value) ?? null,
            analysis: analysis.value ?? null,
          }),
        };
      }),
    );

  plan
    .command("lint")
    .description(
      "Check the plan: every consumer of a breaking change migrates, providers first, a strategy per policy",
    )
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => {
        const r = await container().resolve("lintSystemPlan").execute(id);
        if (r.isErr()) return { result: r };
        const errors = r.value.problems.filter((p) => p.severity === "error");
        const warnings = r.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.step ?? id}: ${p.message}`);
        if (errors.length > 0)
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${id}: ${errors.length} problem(s)`, {
                hint: "Fix the steps or strategies in the plan, then lint again.",
                details: { problems: r.value.problems },
              }),
            ),
          };
        return {
          result: ok({ id, problems: r.value.problems, waves: systemPlanWaves(r.value.plan) }),
          warnings,
        };
      }),
    );

  plan
    .command("approve")
    .description("Approve the plan's steps as they are now (a person, never an agent)")
    .argument("<id>", "the plan id")
    .option("--by <name>", "who approves (default METATOR_USER or the login)")
    .action(
      action(async (id: string, opts: { by?: string }) => ({
        result: await container()
          .resolve("approveSystemPlan")
          .execute({ id, by: opts.by ?? person(process.env) }),
      })),
    );

  plan
    .command("schema")
    .description("Print the JSON Schema of a system plan (or, with --analysis, of its analysis)")
    .option("--analysis", "the analysis instead", false)
    .action(
      action(async (opts: { analysis: boolean }) => ({
        result: ok((opts.analysis ? SystemAnalysisDocument : SystemPlanDocument).jsonSchema("input")),
      })),
    );
}
