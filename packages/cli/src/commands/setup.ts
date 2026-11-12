import {
  err,
  type FileSystem,
  HOST_TARGETS,
  type HostTarget,
  hostsFromEvidence,
  type InstallReport,
  type InstallStep,
  MetatorError,
  ok,
  type Result,
  repositoryHosts,
  writesFile,
} from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";

/** What `setup` runs after installing, as proof the repository is ready for agents. */
export const SETUP_CHECKS: readonly (readonly string[])[] = [
  ["meta", "agents-lint"],
  ["meta", "skills-lint"],
  ["workflow", "lint"],
  ["generate", "--check"],
];

/** Where a host leaves its files in a repository (`repositoryHosts` reads the matches). */
const HOST_SIGNS = [
  ".claude/**",
  "CLAUDE.md",
  ".github/copilot*",
  ".github/{agents,skills,prompts,instructions}/**",
];

interface InstallOptions {
  readonly workflows?: string[];
  readonly theirs: boolean;
  readonly dryRun: boolean;
  readonly generate: boolean;
}

const conflictWarnings = (steps: readonly InstallStep[]) =>
  steps
    .filter((s) => s.action === "conflict")
    .map((s) => `${s.path}: changed here and in the canon; kept yours (--theirs takes the canon's)`);

const upstreamWarnings = (removed: readonly string[]) =>
  removed.map((f) => `${f}: no longer shipped; delete it if nothing of yours depends on it`);

export function registerSetupCommands(
  program: Command,
  { action, container, invoke, terminal }: CommandContext,
): void {
  const agents = program
    .command("agents")
    .description("The agents, skills and workflows shipped with MetatorAI, installed into this repository");

  for (const mode of ["install", "update"] as const) {
    agents
      .command(mode)
      .description(
        mode === "install"
          ? "Copy the shipped agents, skills and workflows here and record them in metator/install.lock.json"
          : "Take the canon of this MetatorAI version; files changed here are kept unless --theirs",
      )
      .option("--workflows <ids...>", "workflows to install (default: all, or the installed ones on update)")
      .option("--theirs", "resolve conflicts with the shipped version", false)
      .option("--dry-run", "report what would change without writing", false)
      .option("--no-generate", "leave the host files (.claude/agents, .github/agents, skills) as they are")
      .action(
        action(async (opts: InstallOptions) => {
          const report = await container()
            .resolve("installCanon")
            .execute({
              mode,
              theirs: opts.theirs,
              dryRun: opts.dryRun,
              ...(opts.workflows ? { workflows: opts.workflows } : {}),
            });
          if (report.isErr()) return { result: report };
          // A changed canon reaches the agents only through their host files: refresh them.
          let generated = 0;
          if (opts.generate && !opts.dryRun && report.value.steps.some((s) => writesFile(s.action))) {
            const hosts = await container().resolve("generateHosts").execute({ check: false, hooks: false });
            if (hosts.isErr()) return { result: hosts };
            const skills = await container().resolve("generateSkills").execute({ check: false });
            if (skills.isErr()) return { result: skills };
            generated = hosts.value.written.length + skills.value.written.length;
          }
          return {
            result: ok({ ...report.value, generated }),
            warnings: [
              ...conflictWarnings(report.value.steps),
              ...upstreamWarnings(report.value.removedUpstream),
            ],
          };
        }),
      );
  }

  program
    .command("setup")
    .description(
      "Set MetatorAI up here in one step: config, hosts, agents, skills, workflows, host files, checks",
    )
    .addOption(
      new Option(
        "--host <hosts...>",
        "AI hosts to generate for (default: the config's, else those the repository or this machine has)",
      ).choices(HOST_TARGETS),
    )
    .option("--workflows <ids...>", "workflows to install (default: all)")
    .option("--hooks", "also install the hooks (`metator guard`) for each host", false)
    .option("--yes", "do not ask; take the options and what was found", false)
    .action(
      action(async (opts: { host?: HostTarget[]; workflows?: string[]; hooks: boolean; yes: boolean }) => {
        const root = (program.opts() as { root?: string }).root;
        const prefix = root ? ["--root", root] : [];
        const c = container();
        const configured = c.resolve("config");
        const installed = await c.resolve("fileSystem").exists(c.resolve("paths").installLock);
        const mode = installed ? "update" : "install";

        const preview = await c.resolve("installCanon").execute({ mode, theirs: false, dryRun: true });
        if (preview.isErr()) return { result: preview };
        // The hosts: the option, else the config, else what the repository and the machine show.
        let hosts: readonly HostTarget[];
        let hostsFrom: "option" | "config" | "found" | "asked" | "default";
        let askHosts = false;
        if (opts.host) [hosts, hostsFrom] = [opts.host, "option"];
        else if (configured.source !== undefined)
          [hosts, hostsFrom] = [configured.config.hosts.targets, "config"];
        else {
          const onPath = c.resolve("launcher").available(HOST_TARGETS);
          const found = hostsFromEvidence({
            repository: repositoryHosts(await c.resolve("fileSystem").glob(HOST_SIGNS)),
            machine: HOST_TARGETS.filter((h) => onPath.includes(h)),
          });
          [hosts, hostsFrom, askHosts] = [found.hosts, found.ask ? "default" : "found", found.ask];
        }
        let answers = {
          hosts,
          // Every workflow: unused ones cost nothing, and --workflows narrows.
          workflows: opts.workflows ?? preview.value.workflows,
          hooks: opts.hooks,
        };
        const ask = opts.yes ? null : terminal;
        if (ask && (askHosts || !opts.hooks)) {
          const given = await ask.setup({ askHosts, defaults: { hosts, hooks: opts.hooks } });
          if (!given) return { result: err(MetatorError.usage("setup cancelled", "Nothing was written.")) };
          answers = { ...answers, hosts: [...given.hosts], hooks: given.hooks };
          if (askHosts) hostsFrom = "asked";
        }

        const warnings: string[] = [];
        const step = async (argv: readonly string[]) => {
          const r = await invoke([...prefix, ...argv]);
          warnings.push(...((r.envelope.warnings as string[] | undefined) ?? []));
          return r;
        };

        if (configured.source === undefined) {
          const init = await step(["init", "--host", ...answers.hosts]);
          if (init.code !== 0) return { result: err(fromEnvelope(init.envelope, "init")) };
        } else if (answers.hosts.join() !== configured.config.hosts.targets.join()) {
          // Hosts chosen now (--host or the questions) win over the file: saved, comments kept.
          const saved = await c.resolve("updateConfig").execute({ hostTargets: answers.hosts });
          if (saved.isErr()) return { result: saved };
        }
        // Setup generates the host files itself, once, after the config and the canon.
        const canon = await step(["agents", mode, "--no-generate", "--workflows", ...answers.workflows]);
        if (canon.code !== 0) return { result: err(fromEnvelope(canon.envelope, `agents ${mode}`)) };
        const generated = await step(["generate", ...(answers.hooks ? ["--hooks"] : [])]);
        if (generated.code !== 0) return { result: err(fromEnvelope(generated.envelope, "generate")) };

        // Local state (the index, runs, worktrees) never goes into a commit.
        const ignored = await ignoreLocalState(c.resolve("fileSystem"));
        if (ignored.isErr()) return { result: ignored };

        const checks = [];
        for (const argv of SETUP_CHECKS) {
          const r = await invoke([...prefix, ...argv]);
          checks.push({ command: argv.join(" "), passed: r.code === 0 });
        }
        const report = canon.envelope.data as InstallReport;
        const summary = {
          config: configured.source ?? "metator.config.yml",
          hosts: answers.hosts,
          hostsFrom,
          workflows: report.workflows,
          hooks: answers.hooks,
          canon: { mode, version: report.version, lock: report.lock, steps: count(report.steps) },
          generated: (generated.envelope.data as { written: string[] }).written.length,
          gitignore: ignored.value,
          checks,
          // What the guide says comes next: what a run cannot do here yet (with --gates: whether the
          // quick gate is green before any run), then the daemon the app talks to.
          next: ["metator doctor", "metator doctor --gates", "metator serve"],
        };
        const failed = checks.filter((k) => !k.passed);
        if (failed.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${failed.length} setup check(s) failed`, {
                hint: "Run each failing command on its own for the details.",
                details: summary,
              }),
            ),
            warnings,
          };
        }
        return { result: ok(summary), warnings };
      }),
    );
}

/** `.metator/` in `.gitignore`: "added", or "present" when a line already ignores it. */
async function ignoreLocalState(
  fs: Pick<FileSystem, "exists" | "read" | "write">,
): Promise<Result<"added" | "present", MetatorError>> {
  const file = ".gitignore";
  const text = (await fs.exists(file)) ? await fs.read(file) : ok("");
  if (text.isErr()) return err(text.error);
  if (text.value.split("\n").some((l) => /^\/?\.metator\/?\s*$/.test(l))) return ok("present");
  const sep = text.value === "" || text.value.endsWith("\n") ? "" : "\n";
  const written = await fs.write(
    file,
    `${text.value}${sep}${text.value === "" ? "" : "\n"}# MetatorAI: local state (index, runs, worktrees)\n.metator/\n`,
  );
  return written.isErr() ? err(written.error) : ok("added");
}

function count(steps: readonly InstallStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) out[s.action] = (out[s.action] ?? 0) + 1;
  return out;
}

function fromEnvelope(envelope: Record<string, unknown>, command: string): MetatorError {
  const e = envelope.error as { code?: string; message?: string; hint?: string } | undefined;
  return new MetatorError("COMMAND_FAILED", `setup stopped at \`${command}\`: ${e?.message ?? "failed"}`, {
    ...(e?.hint ? { hint: e.hint } : {}),
    details: { step: command, error: e ?? null },
  });
}
