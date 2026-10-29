import {
  ArchEvalCaseDocument,
  err,
  MetatorError,
  ok,
  PLAN_GOALS,
  type PlanGoal,
  RefactorPlanDocument,
  RunArchEvals,
} from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { person } from "../live.ts";
import { defaultHost, HOSTS } from "../sessions.ts";

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
      action(async (title: string[], opts: { goal: PlanGoal }) => ({
        result: await container()
          .resolve("createRefactorPlan")
          .execute({ title: title.join(" "), goal: opts.goal, by: person(process.env) }),
      })),
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
        const r = await c.resolve("proposeRefactorPlan").execute({
          title: title.join(" "),
          goal: opts.goal,
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
          warnings: r.isOk() ? r.value.problems.map((p) => `${p.move ? `${p.move}: ` : ""}${p.message}`) : [],
        };
      }),
    );

  plan
    .command("list")
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

  plan
    .command("show")
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

  plan
    .command("lint")
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
    .option("--by <name>", "who approves (default METATOR_USER or the login)")
    .action(
      action(async (id: string, opts: { by?: string }) => ({
        result: await container()
          .resolve("approveRefactorPlan")
          .execute({ id, by: opts.by ?? person(process.env) }),
      })),
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

  plan
    .command("status")
    .description("Read the moves' runs back into the plan: done, blocked, the plan done when all are")
    .argument("<id>", "the plan id")
    .action(
      action(async (id: string) => ({ result: await container().resolve("syncRefactorPlan").execute(id) })),
    );

  plan
    .command("schema")
    .description("Print the JSON Schema of a refactor plan")
    .action(action(async () => ({ result: ok(RefactorPlanDocument.jsonSchema("input")) })));
}

const PLANNER_FILES = [".claude/agents/mt-arch-planner.md", ".github/agents/mt-arch-planner.agent.md"];

/** `arch eval` (H7): the golden set of refactor planning, each case planned in a fresh repository. */
export function registerArchEvalCommands(
  arch: Command,
  { action, container, containerAt }: CommandContext,
): void {
  const evals = () => {
    const c = container();
    const fs = c.resolve("fileSystem");
    return new RunArchEvals(
      fs,
      c.resolve("paths").archEvals,
      c.resolve("sandbox"),
      (root) => {
        const there = containerAt(root);
        return { propose: there.resolve("proposeRefactorPlan"), facts: there.resolve("architectureFacts") };
      },
      // The planner's definition for the hosts, as `agents install` writes it in this repository.
      async () => {
        const out: Record<string, string> = {};
        for (const file of PLANNER_FILES) {
          const text = await fs.read(file);
          if (text.isOk()) out[file] = text.value;
        }
        return out;
      },
    );
  };
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
    .option("--min <score>", "fail below this mean score (0 to 1)")
    .action(
      action(async (opts: { case?: string; host?: string; min?: string }) => {
        const r = await evals().execute({
          host: opts.host ?? defaultHost(container()),
          by: person(process.env),
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
    .action(action(async () => ({ result: ok(ArchEvalCaseDocument.jsonSchema("input")) })));
}
