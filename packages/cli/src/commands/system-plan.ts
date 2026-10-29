import { basename } from "node:path";
import {
  err,
  MetatorError,
  ok,
  planId,
  type Result,
  RunSystemEvals,
  RunSystemPlan,
  SystemAnalysisDocument,
  SystemEvalCaseDocument,
  SystemPlanDocument,
  SystemPlanStatus,
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

  /**
   * The plan a command works on: named, or the plan of a system run (`--run <id or run dir>`,
   * as a W13 gate passes `{runDir}`), whose id comes from the run's task.
   */
  const planOf = async (
    id: string | undefined,
    run: string | undefined,
  ): Promise<Result<{ id: string; parent?: string }, MetatorError>> => {
    if (id) return ok({ id });
    if (!run) return err(MetatorError.usage("name the plan, or pass --run <system run>"));
    const runId = basename(run.replace(/\/+$/, ""));
    const record = await container().resolve("runRepository").load(runId);
    return record.map((r) => ({ id: planId(r.task), parent: r.runId }));
  };
  /** Run tools of the repository at `root` (this one, or an application's checkout). */
  const runsAt = (root: string) => {
    const c = root === container().resolve("root") ? container() : ctx.containerAt(root);
    return { init: c.resolve("initRun"), runs: c.resolve("runRepository") };
  };

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
    .argument("[id]", "the plan id")
    .option("--run <run>", "the plan of this system run (an id or its run directory)")
    .action(
      action(async (named: string | undefined, opts: { run?: string }) => {
        const which = await planOf(named, opts.run);
        if (which.isErr()) return { result: which };
        const id = which.value.id;
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
    .command("run")
    .description("Start the steps that can start: a child run (W1) in each application's repository")
    .argument("[id]", "the plan id")
    .option("--run <run>", "the system run (W13) the child runs belong to; its plan when no id is given")
    .option("--base <ref>", "start each child run in a new worktree branched from this ref")
    .option("--workflow <id>", "the workflow of the child runs", "mt-feature")
    .action(
      action(async (named: string | undefined, opts: { run?: string; base?: string; workflow: string }) => {
        const which = await planOf(named, opts.run);
        if (which.isErr()) return { result: which };
        const c = container();
        const r = await new RunSystemPlan(
          c.resolve("systemPlanStore"),
          c.resolve("systemLocation"),
          c.resolve("systemSources"),
          runsAt,
          c.resolve("clock"),
          c.resolve("runRepository"),
        ).execute({
          id: which.value.id,
          ...(which.value.parent ? { parent: which.value.parent } : {}),
          ...(opts.base ? { base: opts.base } : {}),
          workflow: opts.workflow,
        });
        return {
          result: r,
          warnings:
            r.isOk() && r.value.started.length === 0 && r.value.plan.status !== "done"
              ? ["no step can start yet: the steps before them are not done (`metator system status`)"]
              : [],
        };
      }),
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

  system
    .command("status")
    .description("Each step's child run read back from its repository; the plan done when every step is")
    .argument("[id]", "the plan id")
    .option("--run <run>", "the plan of this system run (an id or its run directory)")
    .option("--check", "fail until every step is done (a W13 gate)", false)
    .action(
      action(async (named: string | undefined, opts: { run?: string; check: boolean }) => {
        const which = await planOf(named, opts.run);
        if (which.isErr()) return { result: which };
        const c = container();
        const r = await new SystemPlanStatus(
          c.resolve("systemPlanStore"),
          c.resolve("systemLocation"),
          c.resolve("systemSources"),
          runsAt,
        ).execute(which.value.id);
        if (r.isErr() || !opts.check || r.value.plan.status === "done") return { result: r };
        const open = r.value.steps.filter((s) => s.status !== "done");
        return {
          result: err(
            new MetatorError("CHECK_FAILED", `${open.length} step(s) of ${which.value.id} are not done`, {
              hint: open.some((s) => s.status === "blocked")
                ? "A child run escalated or was aborted: resolve it in its repository."
                : "Start the next steps with `metator system plan run`, then check again.",
              details: { steps: r.value.steps },
            }),
          ),
        };
      }),
    );

  const evals = () => {
    const c = container();
    const fs = c.resolve("fileSystem");
    return new RunSystemEvals(
      fs,
      c.resolve("paths").systemEvals,
      c.resolve("sandbox"),
      (root) => {
        const there = ctx.containerAt(root);
        return {
          create: there.resolve("createSystemPlan"),
          propose: there.resolve("proposeSystemPlan"),
          lint: there.resolve("lintSystemPlan"),
          store: there.resolve("systemPlanStore"),
        };
      },
      // The system agents' definitions for the hosts, as `agents install` writes them here.
      async () => {
        const out: Record<string, string> = {};
        for (const file of SYSTEM_AGENT_FILES) {
          const text = await fs.read(file);
          if (text.isOk()) out[file] = text.value;
        }
        return out;
      },
    );
  };
  const evalCmd = system.command("eval").description("Score system analysis and planning on the golden set");
  evalCmd
    .command("list")
    .description("The golden cases (docs/metator/evals/system)")
    .action(
      action(async () => ({
        result: (await evals().cases()).map((cases) => ({
          cases: cases.map((c) => ({
            id: c.id,
            task: c.task,
            files: Object.keys(c.files).length,
            expect: c.expect,
          })),
        })),
      })),
    );
  evalCmd
    .command("run")
    .description(
      "Analyze and plan every case in a fresh repository (with --host, the system agents too) and score it",
    )
    .option("--case <id>", "only this case")
    .option(
      "--host <host>",
      `refine with mt-system-scout and mt-system-planner on this AI host: ${HOSTS.join(", ")}`,
    )
    .option("--min <score>", "fail below this mean score (0 to 1)")
    .action(
      action(async (opts: { case?: string; host?: string; min?: string }) => {
        const r = await evals().execute({
          by: person(process.env),
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.case ? { only: opts.case } : {}),
        });
        if (r.isErr() || opts.min === undefined || r.value.summary.score >= Number(opts.min))
          return { result: r };
        return {
          result: err(
            new MetatorError("CHECK_FAILED", `mean score ${r.value.summary.score} is below ${opts.min}`, {
              details: { ...r.value },
            }),
          ),
        };
      }),
    );
  evalCmd
    .command("schema")
    .description("Print the JSON Schema of a golden case")
    .action(action(async () => ({ result: ok(SystemEvalCaseDocument.jsonSchema("input")) })));
}

const SYSTEM_AGENT_FILES = [
  ".claude/agents/mt-system-scout.md",
  ".claude/agents/mt-system-planner.md",
  ".github/agents/mt-system-scout.agent.md",
  ".github/agents/mt-system-planner.agent.md",
];
