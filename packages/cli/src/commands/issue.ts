import {
  err,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  type IssuePriority,
  type IssueRef,
  type IssueStatus,
  MetatorError,
  unreadableIssueWarning,
} from "@metator/core";
import { type Command, Option } from "commander";
import { meta, renamedCommand } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { byOption, defined } from "../options.ts";
import { renderIssues } from "../render.ts";
import { who } from "../who.ts";

/**
 * `metator issue` (S4, design/13 §4): the repository's backlog. A person adds, edits, closes,
 * drops and starts tasks; an agent only proposes (`issue propose`), which puts a question in
 * the inbox; the answer there is the decision.
 */
export function registerIssueCommands(program: Command, ctx: CommandContext): void {
  const { action, runs } = ctx;
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

  meta(issue.command("list"), { audience: "person", reads: true, render: renderIssues })
    .description("The backlog, the most pressing first")
    .addOption(new Option("--status <status>", "only these").choices(ISSUE_STATUSES))
    .option("--run <id>", "only the tasks of this run (proposed from it, started as it, or pointing at it)")
    .action(
      action(async (opts: { status?: IssueStatus; run?: string }) => ({
        result: (
          await runs()
            .resolve("backlogWork")
            .list({
              ...(opts.status ? { status: opts.status } : {}),
              ...(opts.run ? { runId: opts.run } : {}),
            })
        ).map((issues) => ({ issues })),
        // An item whose file cannot be read is left out of the list; the person is told which.
        warnings: (await runs().resolve("issues").unreadable()).map(unreadableIssueWarning),
      })),
    );

  meta(issue.command("show <id>"), { reads: true })
    .description("One task with everything attached: its analysis, its plan, their freshness, its children")
    .action(action(async (id: string) => ({ result: await runs().resolve("backlogWork").detail(id) })));

  issue
    .command("analyze")
    .description(
      "Record an analysis (the agent's text with path:line citations): a new item, or --issue to replace one's analysis; MetatorAI adds the deterministic facts",
    )
    .requiredOption("--text <markdown>", "the analysis; `-` reads it from stdin (a here-doc)")
    .option("--title <words>", "the new item's title (without --issue)")
    .option("--issue <id>", "the item whose analysis this is (re-analyse)")
    .option("--agent <id>", "the agent that wrote it", "mt-chat")
    .addOption(byOption("who asked for it"))
    .action(
      action(async (opts: { text: string; title?: string; issue?: string; agent: string; by?: string }) => {
        const by = await who(runs(), opts.by);
        if (by.isErr()) return { result: by };
        const text = opts.text === "-" ? await ctx.stdin() : opts.text;
        // Recorded from a thread's chat: the item belongs to that thread.
        const pane = process.env.METATOR_PANE_ID;
        const thread = pane ? await runs().resolve("threads").ofPane(pane) : undefined;
        return {
          result: await runs()
            .resolve("backlogWork")
            .analyze({
              text,
              by: by.value,
              agent: opts.agent,
              ...defined({ title: opts.title, issue: opts.issue }),
              ...(thread?.isOk() ? { threadId: thread.value.id } : {}),
            }),
        };
      }),
    );

  meta(issue.command("plan <id>"), { audience: "person" })
    .description(
      "Make the item's plan only: a run of its workflow that stops once a person approves the plan (refused while its analysis is stale)",
    )
    .option("--workflow <id>", "the workflow (default: mt-feature, mt-bugfix for a bug)")
    .option(
      "--session",
      "open the run's conductor where a person sees it (the daemon; without one it is driven in the background)",
      false,
    )
    .option("--host <id>", "with --session: the host of the conductor")
    .action(
      action(async (id: string, opts: { workflow?: string; session: boolean; host?: string }) => ({
        result: await runs()
          .resolve("backlogWork")
          .plan(id, {
            ...defined({ workflow: opts.workflow }),
            ...(opts.session ? { session: defined({ host: opts.host }) } : {}),
          }),
      })),
    );

  issue
    .command("from-plan")
    .description(
      "Make Backlog items from a run's plan: one parent and, for a system plan, one child per step (dependencies kept)",
    )
    .requiredOption("--run <id>", "the plan run or the system run")
    .addOption(byOption("who adds them"))
    .action(
      action(async (opts: { run: string; by?: string }) => {
        const by = await who(runs(), opts.by);
        if (by.isErr()) return { result: by };
        return { result: await runs().resolve("backlogWork").fromPlan({ runId: opts.run, by: by.value }) };
      }),
    );

  issue
    .command("add <title>")
    .description("A person adds a task: open at once")
    .option("--body <text>", "what and why, with the acceptance criterion")
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .option("--ref <ref...>", "what it points at: <file>[:line], run:<id>[/<step>]")
    .addOption(byOption("who adds it"))
    .action(
      action(
        async (
          title: string,
          opts: { body?: string; priority?: IssuePriority; labels?: string; ref?: string[]; by?: string },
        ) => {
          const by = await who(runs(), opts.by);
          if (by.isErr()) return { result: by };
          return {
            result: await runs()
              .resolve("issues")
              .add({
                title,
                ...(opts.body !== undefined ? { body: opts.body } : {}),
                ...(opts.priority ? { priority: opts.priority } : {}),
                ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
                refs: refs(opts.ref),
                by: by.value,
              }),
          };
        },
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
    .addOption(new Option("--add", "add it to the backlog").default(false).conflicts("drop"))
    .option("--drop", "drop it", false)
    .addOption(priority)
    .option("--labels <a,b>", "labels, comma-separated")
    .addOption(byOption("who decides"))
    .action(
      action(
        async (
          id: string,
          opts: { add: boolean; drop: boolean; priority?: IssuePriority; labels?: string; by?: string },
        ) => {
          if (!opts.add && !opts.drop)
            return { result: err(MetatorError.usage("say what you decide: --add or --drop")) };
          const by = await who(runs(), opts.by);
          if (by.isErr()) return { result: by };
          return {
            result: await runs()
              .resolve("issues")
              .decide(id, {
                by: by.value,
                decision: opts.drop ? "drop" : "add",
                ...(opts.priority ? { priority: opts.priority } : {}),
                ...(labels(opts.labels) ? { labels: labels(opts.labels) as string[] } : {}),
              }),
          };
        },
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
    .addOption(byOption("who closes it"))
    .action(
      action(async (id: string, opts: { by?: string }) => {
        const by = await who(runs(), opts.by);
        return { result: by.isErr() ? by : await runs().resolve("issues").close(id, { by: by.value }) };
      }),
    );

  // `issue rm`, as a worktree and a policy are removed; `issue drop` is its old name.
  renamedCommand({ parent: issue, name: "drop" }, { parent: issue, name: "rm" }, (cmd) =>
    cmd
      .argument("<id>", "the task's id")
      .description("The task is not going to be done: it stays in the backlog as dropped")
      .addOption(byOption("who drops it"))
      .action(
        action(async (id: string, opts: { by?: string }) => {
          const by = await who(runs(), opts.by);
          return { result: by.isErr() ? by : await runs().resolve("issues").drop(id, { by: by.value }) };
        }),
      ),
  );

  meta(issue.command("start <id>"), { audience: "person" })
    .description(
      "A run on the task (its title and body are the task), in its own worktree unless --no-worktree: from its plan at build when the plan still holds, from the plan's review when it does not; a child only once what it waits for is done",
    )
    .option("--workflow <id>", "the workflow to run (default: mt-feature, mt-bugfix for a bug)")
    .option(
      "--session",
      "open the run's conductor where a person sees it (the daemon; without one it is driven in the background)",
      false,
    )
    .option("--host <id>", "with --session: the host of the conductor")
    .addOption(byOption("who starts it"))
    .option("--no-worktree", "work in the main checkout")
    .option(
      "--allow-dirty",
      "start although tracked files have uncommitted changes (the worktree starts from the last commit, without them)",
      false,
    )
    .addOption(
      new Option("--autonomy <level>", "L0: every approval waits for you").choices(["L0", "L1", "L2"]),
    )
    .action(
      action(
        async (
          id: string,
          opts: {
            workflow?: string;
            worktree: boolean;
            allowDirty: boolean;
            autonomy?: "L0" | "L1" | "L2";
            session: boolean;
            host?: string;
            by?: string;
          },
        ) => {
          const by = await who(runs(), opts.by);
          if (by.isErr()) return { result: by };
          return {
            result: await runs()
              .resolve("backlogWork")
              .implement(id, {
                by: by.value,
                worktree: opts.worktree,
                ...defined({ workflow: opts.workflow, autonomy: opts.autonomy }),
                ...(opts.allowDirty ? { allowDirty: true } : {}),
                ...(opts.session ? { session: defined({ host: opts.host }) } : {}),
              }),
          };
        },
      ),
    );
}
