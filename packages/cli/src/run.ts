import {
  AutonomySchema,
  err,
  MetatorError,
  ok,
  type Result,
  type RunEvent,
  workflowJsonSchema,
} from "@metator/core";
import {
  bootstrap,
  exitCodeFor,
  findRepoRoot,
  fromUnknown,
  type MetatorContainer,
  serialize,
  toEnvelope,
} from "@metator/runtime";
import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };

export interface Io {
  readonly out: (text: string) => void;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Outcome {
  readonly result: Result<unknown, MetatorError>;
  readonly warnings?: readonly string[];
}

const EVENTS = ["pass", "fail", "approve", "abort"] as const;

/** Driving adapter: argv → commander → use case → one JSON envelope line → exit code. */
export async function run(argv: readonly string[], io: Io, options: RunOptions = {}): Promise<number> {
  let outcome: Outcome | undefined;
  const program = buildProgram((o) => {
    outcome = o;
  }, options);
  try {
    await program.parseAsync(argv.length === 0 ? ["help"] : [...argv], { from: "user" });
    outcome ??= { result: ok(describeCommands(program)) }; // a command group without subcommand → help
  } catch (e) {
    outcome = { result: err(e instanceof CommanderError ? fromCommander(e, program) : fromUnknown(e)) };
  }
  const final = outcome as Outcome;
  io.out(serialize(toEnvelope(final.result, final.warnings ?? [])));
  return final.result.isOk() ? 0 : exitCodeFor(final.result.error);
}

function buildProgram(set: (o: Outcome) => void, options: RunOptions): Command {
  const program = new Command("metator")
    .description("MetatorAI: survey first, prove everything.")
    .option("-C, --root <dir>", "repository root (default: nearest ancestor with .git)")
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .helpCommand(false);

  const container = (): MetatorContainer => {
    const root = (program.opts() as { root?: string }).root ?? findRepoRoot(options.cwd ?? process.cwd());
    const now = (options.env ?? process.env).METATOR_NOW;
    return bootstrap(now ? { root, now } : { root });
  };
  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<Outcome> | Outcome) =>
    async (...args: A) => {
      set(await fn(...args));
    };

  program
    .command("version")
    .description("Print the MetatorAI version")
    .action(action(() => ({ result: ok({ name: "metator-ai", version: pkg.version }) })));

  program
    .command("help")
    .description("List available commands")
    .action(action(() => ({ result: ok(describeCommands(program)) })));

  program
    .command("changed")
    .description("Files changed against a git ref (committed on the branch, staged, unstaged, untracked)")
    .option("--base <ref>", "git ref to compare against", "HEAD")
    .action(
      action(async (opts: { base: string }) => {
        const files = await container().resolve("vcs").changedFiles(opts.base);
        return { result: files.map((list) => ({ base: opts.base, files: list })) };
      }),
    );

  const workflow = program.command("workflow").description("Inspect and validate workflow specs");
  workflow
    .command("list")
    .description("List workflows declared in .github/metator/workflows")
    .action(
      action(async () => {
        const scan = await container().resolve("workflowCatalog").scan();
        return {
          result: ok({
            workflows: scan.workflows.map(({ spec, source }) => ({
              id: spec.id,
              version: spec.version,
              stages: spec.stages.map((s) => s.id),
              source,
            })),
          }),
          warnings: scan.problems.map((p) => `${p.source}: ${p.error.message}`),
        };
      }),
    );
  workflow
    .command("validate")
    .description("Validate one spec file, or every spec in the repository")
    .argument("[file]", "repo-relative path to a workflow YAML file")
    .action(
      action(async (file: string | undefined) => {
        const catalog = container().resolve("workflowCatalog");
        if (file) {
          const entry = await catalog.parse(file);
          return { result: entry.map(({ spec, source }) => ({ valid: [{ id: spec.id, source }] })) };
        }
        const scan = await catalog.scan();
        if (scan.problems.length > 0) {
          return {
            result: err(
              new MetatorError("INVALID_CONFIG", `${scan.problems.length} invalid workflow spec(s)`, {
                details: { problems: scan.problems.map((p) => ({ source: p.source, ...p.error.toJSON() })) },
              }),
            ),
          };
        }
        return { result: ok({ valid: scan.workflows.map(({ spec, source }) => ({ id: spec.id, source })) }) };
      }),
    );
  workflow
    .command("schema")
    .description("Print the JSON Schema of a workflow spec")
    .action(action(() => ({ result: ok(workflowJsonSchema()) })));

  const runs = program.command("run").description("Start and drive workflow runs (state machine)");
  runs
    .command("init")
    .description("Start a run of a workflow")
    .requiredOption("--workflow <id>", "workflow id")
    .requiredOption("--task <text>", "task description or work item reference")
    .option("--autonomy <level>", "L0 (all gates), L1 (skip plan approval), L2 (headless)", "L0")
    .action(
      action(async (opts: { workflow: string; task: string; autonomy: string }) => {
        const autonomy = AutonomySchema.safeParse(opts.autonomy);
        if (!autonomy.success) {
          return {
            result: err(MetatorError.usage(`Invalid --autonomy "${opts.autonomy}"`, "Use L0, L1 or L2.")),
          };
        }
        const task = opts.task.trim();
        if (task === "") return { result: err(MetatorError.usage("--task must not be empty")) };
        const input = { workflow: opts.workflow, task, autonomy: autonomy.data };
        return { result: await container().resolve("initRun").execute(input) };
      }),
    );
  runs
    .command("advance")
    .description("Send an event to the current stage: pass | fail | approve | abort")
    .argument("<event>", EVENTS.join(" | "))
    .option("--run <id>", "run id (default: latest)")
    .option("--reason <text>", "why (fail, abort)")
    .option("--by <name>", "who decided (required for approve)")
    .option("--choice <value>", "selected option at a gate")
    .action(
      action(async (name: string, opts: { run?: string; reason?: string; by?: string; choice?: string }) => {
        const event = toEvent(name, opts);
        if (event.isErr()) return { result: err(event.error) };
        const input = opts.run ? { runId: opts.run, event: event.value } : { event: event.value };
        return { result: await container().resolve("advanceRun").execute(input) };
      }),
    );
  runs
    .command("status")
    .description("Show the current stage, what it expects and recent history")
    .option("--run <id>", "run id (default: latest)")
    .action(
      action(async (opts: { run?: string }) => ({
        result: await container()
          .resolve("getRunStatus")
          .execute(opts.run ? { runId: opts.run } : {}),
      })),
    );
  runs
    .command("list")
    .description("List runs, newest first")
    .action(action(async () => ({ result: await container().resolve("listRuns").execute() })));

  return program;
}

function toEvent(
  name: string,
  opts: { reason?: string; by?: string; choice?: string },
): Result<RunEvent, MetatorError> {
  switch (name.toLowerCase()) {
    case "pass":
      return ok({ type: "PASS" });
    case "fail":
      return ok(opts.reason ? { type: "FAIL", reason: opts.reason } : { type: "FAIL" });
    case "approve":
      if (!opts.by?.trim()) {
        return err(MetatorError.usage("approve requires --by <name>", "Gates record who made the decision."));
      }
      return ok(
        opts.choice
          ? { type: "APPROVE", by: opts.by, choice: opts.choice }
          : { type: "APPROVE", by: opts.by },
      );
    case "abort":
      if (!opts.reason?.trim()) return err(MetatorError.usage("abort requires --reason <text>"));
      return ok({ type: "ABORT", reason: opts.reason });
    default:
      return err(MetatorError.usage(`Unknown event "${name}"`, `Use one of: ${EVENTS.join(", ")}.`));
  }
}

interface CommandInfo {
  name: string;
  summary: string;
  usage: string;
}

function describeCommands(program: Command): { commands: CommandInfo[] } {
  const commands: CommandInfo[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      const name = `${prefix}${sub.name()}`;
      if (sub.commands.length > 0) walk(sub, `${name} `);
      else
        commands.push({ name, summary: sub.description(), usage: `metator ${name} ${sub.usage()}`.trim() });
    }
  };
  walk(program, "");
  return { commands };
}

function fromCommander(e: CommanderError, program: Command): MetatorError {
  if (e.code === "commander.helpDisplayed" || e.code === "commander.help") {
    return new MetatorError("USAGE", "Use `metator help` for machine-readable help", {
      details: describeCommands(program),
    });
  }
  return MetatorError.usage(
    e.message.replace(/^error:\s*/, ""),
    "Run `metator help` to list commands and options.",
  );
}
