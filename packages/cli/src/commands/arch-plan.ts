import {
  ArchEvalCaseDocument,
  err,
  MetatorError,
  ok,
  PLAN_GOALS,
  type PlanGoal,
  RefactorPlanDocument,
} from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { byOption } from "../options.ts";
import { schemaCommand } from "../outcome.ts";
import { defaultHost, HOSTS } from "../sessions.ts";
import { asPerson, who } from "../who.ts";
import { minScore } from "./system-plan.ts";

const goal = () =>
  new Option("--goal <goal>", "what the plan must reach").choices([...PLAN_GOALS]).default("no-cycles");

/** `arch plan` (H5, H6): refactor plans that the tool simulates, a person approves and W3 runs execute. */
export function registerArchPlanCommands(
  arch: Command,
  { action, container, terminal }: CommandContext,
): void {
  const plan = arch
    .command("plan")
    .description("Refactor plans: moves with reasons, simulated, approved, run as W3 runs");

  plan
    .command("new")
    .description("Start an empty draft plan in metator/arch/plans/")
    .argument("<title...>", "what the refactor is for")
    .addOption(goal())
    .action(
      action(async (title: string[], opts: { goal: PlanGoal }) =>
        asPerson(container(), undefined, async (by) => ({
          result: await container()
            .resolve("createRefactorPlan")
            .execute({ title: title.join(" "), goal: opts.goal, by }),
        })),
      ),
    );

  plan
    .command("propose")
    .description("Let mt-arch-planner fill a plan on your AI host, then simulate and lint it")
    .argument("<title...>", "what the refactor is for")
    .addOption(goal())
    .option("--host <host>", `the AI host that plans: ${HOSTS.join(", ")}`)
    .action(
      action(async (title: string[], opts: { goal: PlanGoal; host?: string }) => {
        const c = container();
        const root = c.resolve("root");
        const t = terminal;
        const by = await who(c);
        if (by.isErr()) return { result: by };
        const r = await c.resolve("proposeRefactorPlan").execute({
          title: title.join(" "),
          goal: opts.goal,
          host: opts.host ?? defaultHost(c),
          by: by.value,
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
          warnings: r.isOk() ? r.value.problems.map((p) => `${p.move ? `${p.move}: ` : ""}${p.message}`) : [],
        };
      }),
    );

  meta(plan.command("list"), { reads: true })
    .description("Every refactor plan with its goal, status and moves")
    .action(
      action(async () => ({
        result: (await container().resolve("refactorPlanStore").list()).map((plans) => ({
          plans: plans.map((p) => ({
            id: p.id,
            title: p.title,
            goal: p.goal,
            status: p.status,
            moves: p.moves.length,
            done: p.moves.filter((m) => m.status === "done").length,
          })),
        })),
      })),
    );

  meta(plan.command("show"), { reads: true })
    .description("One refactor plan")
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => ({ result: await container().resolve("refactorPlanStore").load(id) })),
    );

  plan
    .command("simulate")
    .description("Write each move's effect and the whole result into the plan")
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => ({
        result: await container().resolve("simulateRefactorPlan").execute(id),
      })),
    );

  meta(plan.command("lint"), { reads: true })
    .description(
      "Check the plan: moves possible, citations real, effects current, no new errors, goal reached",
    )
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => {
        const r = await container().resolve("lintRefactorPlan").execute(id);
        if (r.isErr()) return { result: r };
        const errors = r.value.problems.filter((p) => p.severity === "error");
        const warnings = r.value.problems
          .filter((p) => p.severity === "warning")
          .map((p) => `${p.move ?? id}: ${p.message}`);
        if (errors.length > 0)
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${id}: ${errors.length} problem(s)`, {
                hint: "Fix the moves, then `metator arch plan simulate` and lint again.",
                details: { problems: r.value.problems },
              }),
            ),
          };
        return { result: ok({ id, problems: r.value.problems }), warnings };
      }),
    );

  plan
    .command("approve")
    .description("Approve the plan's moves as they are now (a person, never an agent)")
    .argument("<id>", "the plan id")
    .addOption(byOption("who approves"))
    .action(
      action(async (id: string, opts: { by?: string }) =>
        asPerson(container(), opts.by, async (by) => ({
          result: await container().resolve("approveRefactorPlan").execute({ id, by }),
        })),
      ),
    );

  plan
    .command("run")
    .description("Start the next wave: one W3 refactor run per move, each in its own worktree")
    .argument("<id>", "the plan id")
    .option("--base <ref>", "branch the worktrees from this ref")
    .action(
      action(async (id: string, opts: { base?: string }) => ({
        result: await container()
          .resolve("runRefactorPlan")
          .execute({ id, ...(opts.base ? { base: opts.base } : {}) }),
      })),
    );

  meta(plan.command("status"), { reads: true })
    .description("Read the moves' runs back into the plan: done, blocked, the plan done when all are")
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => ({ result: await container().resolve("syncRefactorPlan").execute(id) })),
    );

  schemaCommand(plan, { action }, "Print the JSON Schema of a refactor plan", RefactorPlanDocument);
}

/** `arch eval` (H7): the golden set of refactor planning, each case planned in a fresh repository. */
export function registerArchEvalCommands(arch: Command, { action, container }: CommandContext): void {
  const evals = () => container().resolve("runArchEvals");
  const evalCmd = arch
    .command("eval")
    .description("Score mt-arch-planner on the golden set of refactor planning");
  evalCmd
    .command("list")
    .description("The golden cases (docs/metator/evals/arch)")
    .action(
      action(async () => ({
        result: (await evals().cases()).map((cases) => ({
          cases: cases.map((c) => ({
            id: c.id,
            goal: c.goal,
            files: Object.keys(c.files).length,
            expect: c.expect,
          })),
        })),
      })),
    );
  evalCmd
    .command("run")
    .description("Plan every case on your AI host in a fresh repository and score the plans")
    .option("--case <id>", "only this case")
    .option("--host <host>", `the AI host that plans: ${HOSTS.join(", ")}`)
    .addOption(minScore())
    .action(
      action(async (opts: { case?: string; host?: string; min?: number }) => {
        const by = await who(container());
        if (by.isErr()) return { result: by };
        const r = await evals().execute({
          host: opts.host ?? defaultHost(container()),
          by: by.value,
          ...(opts.case ? { only: opts.case } : {}),
        });
        if (r.isErr() || opts.min === undefined || r.value.summary.score >= opts.min) return { result: r };
        return {
          result: err(
            new MetatorError("CHECK_FAILED", `mean score ${r.value.summary.score} is below ${opts.min}`, {
              details: { ...r.value },
            }),
          ),
        };
      }),
    );
  schemaCommand(evalCmd, { action }, "Print the JSON Schema of a golden case", ArchEvalCaseDocument);
}
