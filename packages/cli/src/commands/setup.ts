import {
  conflictWarnings,
  err,
  HOST_TARGETS,
  type HostTarget,
  MetatorError,
  ok,
  upstreamWarnings,
  writesFile,
} from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { defined } from "../options.ts";

interface InstallOptions {
  readonly workflows?: string[];
  readonly theirs: boolean;
  readonly dryRun: boolean;
  readonly generate: boolean;
}

export function registerSetupCommands(
  program: Command,
  { action, container, terminal }: CommandContext,
): void {
  const agents = program
    .command("agents")
    .description("The agents, skills and workflows shipped with MetatorAI, installed into this repository");

  for (const mode of ["install", "update"] as const) {
    meta(agents.command(mode), mode === "update" ? { audience: "person" } : {})
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

  meta(program.command("setup"), { audience: "person" })
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
    .option("--hooks", "install the hooks (`metator guard`) for each host without asking (the default)")
    .option(
      "--no-hooks",
      "do not install the hooks: nothing then guards commits and pushes, and a word in the chat is no consent",
    )
    .option("--yes", "do not ask; take the options and what was found", false)
    .action(
      action(async (opts: { host?: HostTarget[]; workflows?: string[]; hooks?: boolean; yes: boolean }) => {
        // The whole setup is one use case (`SetupRepository`); only the questions are the terminal's.
        const ask = opts.yes ? null : terminal;
        const done = await container()
          .resolve("setupRepository")
          .execute({
            ...defined({ hosts: opts.host, workflows: opts.workflows }),
            ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
            ...(ask
              ? {
                  ask: async (q) =>
                    ask.setup({
                      askHosts: q.askHosts,
                      askHooks: q.askHooks,
                      defaults: { hosts: q.defaults.hosts, hooks: q.defaults.hooks },
                    }),
                }
              : {}),
          });
        if (done.isErr()) return { result: done };
        const { report, warnings } = done.value;
        const failed = report.checks.filter((k) => !k.passed);
        if (failed.length > 0)
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${failed.length} setup check(s) failed`, {
                hint: "Run each failing command on its own for the details.",
                details: { ...report },
              }),
            ),
            warnings,
          };
        return { result: ok(report), warnings };
      }),
    );
}
