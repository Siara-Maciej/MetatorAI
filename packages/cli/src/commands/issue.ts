import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueRef,
  type IssueStatus,
} from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";

/**
 * `metator issue` (S4, design/13 §4): the repository's backlog. A person adds, edits, closes,
 * drops and starts tasks; an agent only proposes (`issue propose`), which puts a question in
 * the inbox; the answer there is the decision.
 */
export function registerIssueCommands(program: Command, { action, runs }: CommandContext): void {
  const issue = program
    .command("issue")
    .description(
      "Local tasks in .metator/issues: a person adds them, an agent only proposes (its proposal is a question in the inbox)",
    );

  const refs = (values: string[] | undefined): IssueRef[] =>
    (values ?? []).map((v) => {
      const run = /^run:([^/]+)(?:\/(S\d+))?$/.exec(v);
      if (run) return { run: run[1] as string, ...(run[2] ? { step: run[2] } : {}) };
      const file = /^(.+?)(?::(\d+))?$/.exec(v);
      return file ? { file: file[1] as string, ...(file[2] ? { line: Number(file[2]) } : {}) } : { note: v };
    });
  const labels = (v: string | undefined) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined;
  const priority = new Option("--priority <level>", "how urgent").choices(ISSUE_PRIORITIES);

  issue
    .command("list")
    .description("The backlog, the most pressing first")
    .addOption(new Option("--status <status>", "only these").choices(ISSUE_STATUSES))
    .option("--run <id>", "only the tasks of this run (proposed from it, started as it, or pointing at it)")
    .action(
      action(async (opts: { status?: IssueStatus; run?: string }) => ({
        result: (
          await runs()
            .resolve("issues")
            .list({
              ...(opts.status ? { status: opts.status } : {}),
              ...(opts.run ? { runId: opts.run } : {}),
            })
        ).map((issues) => ({ issues })),
      })),
    );

  issue
    .command("show <id>")
    .description("One task with everything attached")
    .action(action(async (id: string) => ({ result: await runs().resolve("issues").show(id) })));

  issue
    .command("add <title>")
    .description("A person adds a task: open at once")
    .option("--body <text>", "what and why, with the acceptance criterion")
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .option("--ref <ref...>", "what it points at: <file>[:line], run:<id>[/<step>]")
    .requiredOption("--by <name>", "who adds it")
    .action(
      action(
        async (
          title: string,
          opts: { body?: string; priority?: IssuePriority; labels?: string; ref?: string[]; by: string },
        ) => ({
          result: await runs()
            .resolve("issues")
            .add({
              title,
              ...(opts.body !== undefined ? { body: opts.body } : {}),
              ...(opts.priority ? { priority: opts.priority } : {}),
              ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
              refs: refs(opts.ref),
              by: opts.by,
            }),
        }),
      ),
    );

  issue
    .command("propose <title>")
    .description("An agent proposes a task: it becomes a question in the inbox; a person decides")
    .option("--body <text>", "what and why, with the acceptance criterion")
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .option("--ref <ref...>", "what it points at: <file>[:line], run:<id>[/<step>]")
    .requiredOption("--agent <id>", "the proposing agent (or worker)")
    .option("--run <id>", "the run it comes from (default: latest)")
    .action(
      action(
        async (
          title: string,
          opts: {
            body?: string;
            priority?: IssuePriority;
            labels?: string;
            ref?: string[];
            agent: string;
            run?: string;
          },
        ) => ({
          result: await runs()
            .resolve("issues")
            .propose({
              title,
              ...(opts.body !== undefined ? { body: opts.body } : {}),
              ...(opts.priority ? { priority: opts.priority } : {}),
              ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
              refs: refs(opts.ref),
              agent: opts.agent,
              ...(opts.run ? { runId: opts.run } : {}),
            }),
        }),
      ),
    );

  issue
    .command("decide <id>")
    .description("A person decides a proposal outside the inbox: --add or --drop")
    .option("--add", "add it to the backlog", false)
    .option("--drop", "drop it", false)
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .requiredOption("--by <name>", "who decides")
    .action(
      action(
        async (
          id: string,
          opts: { add: boolean; drop: boolean; priority?: IssuePriority; labels?: string; by: string },
        ) => ({
          result: await runs()
            .resolve("issues")
            .decide(id, {
              by: opts.by,
              decision: opts.drop ? "drop" : "add",
              ...(opts.priority ? { priority: opts.priority } : {}),
              ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
            }),
        }),
      ),
    );

  issue
    .command("edit <id>")
    .description("Change a task's title, body, priority, labels or refs")
    .option("--title <text>")
    .option("--body <text>")
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .option("--ref <ref...>", "replaces the refs")
    .action(
      action(
        async (
          id: string,
          opts: { title?: string; body?: string; priority?: IssuePriority; labels?: string; ref?: string[] },
        ) => ({
          result: await runs()
            .resolve("issues")
            .edit(id, {
              ...(opts.title !== undefined ? { title: opts.title } : {}),
              ...(opts.body !== undefined ? { body: opts.body } : {}),
              ...(opts.priority ? { priority: opts.priority } : {}),
              ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
              ...(opts.ref ? { refs: refs(opts.ref) } : {}),
            }),
        }),
      ),
    );

  issue
    .command("close <id>")
    .description("The task is done")
    .requiredOption("--by <name>", "who closes it")
    .action(
      action(async (id: string, opts: { by: string }) => ({
        result: await runs().resolve("issues").close(id, opts),
      })),
    );

  issue
    .command("drop <id>")
    .description("The task is not going to be done")
    .requiredOption("--by <name>", "who drops it")
    .action(
      action(async (id: string, opts: { by: string }) => ({
        result: await runs().resolve("issues").drop(id, opts),
      })),
    );

  issue
    .command("start <id>")
    .description(
      "A run on the task (its title and body are the task), in its own worktree unless --no-worktree",
    )
    .requiredOption("--workflow <id>", "the workflow to run")
    .option("--no-worktree", "work in the main checkout")
    .addOption(new Option("--autonomy <level>", "L0 asks at every gate").choices(["L0", "L1", "L2"]))
    .action(
      action(
        async (id: string, opts: { workflow: string; worktree: boolean; autonomy?: "L0" | "L1" | "L2" }) => ({
          result: await runs()
            .resolve("issues")
            .start(id, {
              workflow: opts.workflow,
              worktree: opts.worktree,
              ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
            }),
        }),
      ),
    );
}
