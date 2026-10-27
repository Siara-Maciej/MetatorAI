import {
  err,
  HOST_TARGETS,
  type HostTarget,
  type InstallReport,
  type InstallStep,
  MetatorError,
  ok,
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

interface InstallOptions {
  readonly workflows?: string[];
  readonly theirs: boolean;
  readonly dryRun: boolean;
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
      .option("--theirs", "resolve conflicts with the canon's version", false)
      .option("--dry-run", "report what would change without writing", false)
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
          return {
            result: report,
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
      new Option("--host <hosts...>", "AI hosts to generate for (default: all)").choices(HOST_TARGETS),
    )
    .option("--workflows <ids...>", "workflows to install (default: all)")
    .option("--hooks", "also install the hooks (`metator guard`) for each host", false)
    .option("--yes", "do not ask; take the options and the defaults", false)
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
        let answers = {
          hosts: opts.host ?? configured.config.hosts.targets,
          workflows: opts.workflows ?? preview.value.workflows,
          hooks: opts.hooks,
        };
        const ask = !opts.yes && opts.host === undefined && opts.workflows === undefined ? terminal : null;
        if (ask) {
          const given = await ask.setup({ available: preview.value.available, defaults: answers });
          if (!given) return { result: err(MetatorError.usage("setup cancelled", "Nothing was written.")) };
          answers = { hosts: [...given.hosts], workflows: [...given.workflows], hooks: given.hooks };
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
          warnings.push(
            `${configured.source} keeps hosts.targets [${configured.config.hosts.targets.join(", ")}]; set it to [${answers.hosts.join(", ")}] to generate for those hosts`,
          );
        }
        const canon = await step(["agents", mode, "--workflows", ...answers.workflows]);
        if (canon.code !== 0) return { result: err(fromEnvelope(canon.envelope, `agents ${mode}`)) };
        const generated = await step(["generate", ...(answers.hooks ? ["--hooks"] : [])]);
        if (generated.code !== 0) return { result: err(fromEnvelope(generated.envelope, "generate")) };

        const checks = [];
        for (const argv of SETUP_CHECKS) {
          const r = await invoke([...prefix, ...argv]);
          checks.push({ command: argv.join(" "), passed: r.code === 0 });
        }
        const report = canon.envelope.data as InstallReport;
        const summary = {
          config: configured.source ?? "metator.config.yml",
          hosts: answers.hosts,
          workflows: report.workflows,
          hooks: answers.hooks,
          canon: { mode, version: report.version, lock: report.lock, steps: count(report.steps) },
          generated: (generated.envelope.data as { written: string[] }).written.length,
          checks,
          next: ["metator workflow list", 'metator run init --workflow mt-feature --task "…"'],
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
