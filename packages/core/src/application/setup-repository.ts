import { HOST_TARGETS, type HostTarget, hostsFromEvidence, repositoryHosts } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import type { InstallStep } from "../domain/install.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { FileSystem } from "../ports/index.ts";
import type { GenerateHosts, LintAgents } from "./agents.ts";
import type { UpdateConfig } from "./config-edit.ts";
import type { InitProject } from "./init.ts";
import type { InstallCanon } from "./install.ts";
import type { GenerateSkills, LintSkills } from "./skills.ts";
import type { LintWorkflows } from "./workflow-catalog.ts";

/**
 * `metator setup`: MetatorAI set up in a repository in one step, as typed calls to the use cases
 * that do each part (the config, the canon, the host files, the checks), not as commands run and
 * their output read back. What is found, asked and written is one report.
 */

/** Where a host leaves its files in a repository (`repositoryHosts` reads the matches). */
export const HOST_SIGNS = [
  ".claude/**",
  "CLAUDE.md",
  ".github/copilot*",
  ".github/{agents,skills,prompts,instructions}/**",
];

/** What `setup` checks after installing, as proof the repository is ready for agents: each a command a person can run. */
export const SETUP_CHECKS = [
  "meta agents-lint",
  "meta skills-lint",
  "workflow lint",
  "generate --check",
] as const;

export const conflictWarnings = (steps: readonly InstallStep[]): string[] =>
  steps
    .filter((s) => s.action === "conflict")
    .map((s) => `${s.path}: changed here and in the canon; kept yours (--theirs takes the canon's)`);

export const upstreamWarnings = (removed: readonly string[]): string[] =>
  removed.map((f) => `${f}: no longer shipped; delete it if nothing of yours depends on it`);

/** The use cases of the repository as it is configured now: after `setup` wrote or changed the config. */
export interface ConfiguredRepository {
  readonly installCanon: Pick<InstallCanon, "execute">;
  readonly generateHosts: Pick<GenerateHosts, "execute">;
  readonly generateSkills: Pick<GenerateSkills, "execute">;
  readonly lintAgents: Pick<LintAgents, "execute">;
  readonly lintSkills: Pick<LintSkills, "execute">;
  readonly lintWorkflows: Pick<LintWorkflows, "execute">;
}

export interface SetupAnswersAsked {
  readonly hosts: readonly HostTarget[];
  readonly hooks: boolean;
}

export interface SetupInput {
  /** `--host`: the AI hosts to generate for; else the config's, else what is found, else asked. */
  readonly hosts?: readonly HostTarget[];
  /** `--workflows`: the workflows to install; all when left out. */
  readonly workflows?: readonly string[];
  /**
   * The hooks (`metator guard`): part of a setup unless the person says no (`--no-hooks`).
   * Without them nothing guards commands, a word in the chat is no consent, and the chat does not
   * hear of direct talk. Left out: installed, and a person at a terminal is asked (default yes).
   */
  readonly hooks?: boolean;
  /** Asks the person (a terminal): which hosts when nothing says, the hooks when nothing says; null: cancelled. */
  readonly ask?: (q: {
    readonly askHosts: boolean;
    readonly askHooks: boolean;
    readonly defaults: SetupAnswersAsked;
  }) => Promise<SetupAnswersAsked | null>;
}

export interface RepositorySetup {
  readonly config: string;
  readonly hosts: readonly HostTarget[];
  readonly hostsFrom: "option" | "config" | "found" | "asked" | "default";
  readonly workflows: readonly string[];
  readonly hooks: boolean;
  readonly canon: {
    readonly mode: "install" | "update";
    readonly version: string;
    readonly lock: string | null;
    readonly steps: Readonly<Record<string, number>>;
  };
  readonly generated: number;
  readonly gitignore: "added" | "present";
  readonly checks: readonly { readonly command: string; readonly passed: boolean }[];
  /** What the guide says comes next. */
  readonly next: readonly string[];
}

export interface SetupDependencies {
  /** The config as it was read when the command started: its file (none: defaults) and its hosts. */
  readonly config: { readonly source: string | undefined; readonly hosts: readonly HostTarget[] };
  readonly installLock: string;
  readonly fs: Pick<FileSystem, "exists" | "read" | "write" | "glob">;
  /** The hosts whose program is on this machine's PATH. */
  readonly hostsOnPath: () => readonly HostTarget[];
  readonly installCanon: Pick<InstallCanon, "execute">;
  readonly initProject: Pick<InitProject, "execute">;
  readonly updateConfig: Pick<UpdateConfig, "execute">;
  /** The use cases over the config `setup` just wrote; an invalid config is its error. */
  readonly configured: () => Result<ConfiguredRepository, MetatorError>;
}

export class SetupRepository {
  constructor(private readonly d: SetupDependencies) {}

  async execute(
    input: SetupInput,
  ): Promise<
    Result<{ readonly report: RepositorySetup; readonly warnings: readonly string[] }, MetatorError>
  > {
    const d = this.d;
    const mode = (await d.fs.exists(d.installLock)) ? "update" : "install";
    const preview = await d.installCanon.execute({ mode, theirs: false, dryRun: true });
    if (preview.isErr()) return err(preview.error);

    // The hosts: the option, else the config, else what the repository and the machine show.
    let hosts: readonly HostTarget[];
    let hostsFrom: RepositorySetup["hostsFrom"];
    let askHosts = false;
    if (input.hosts) [hosts, hostsFrom] = [input.hosts, "option"];
    else if (d.config.source !== undefined) [hosts, hostsFrom] = [d.config.hosts, "config"];
    else {
      const onPath = d.hostsOnPath();
      const found = hostsFromEvidence({
        repository: repositoryHosts(await d.fs.glob(HOST_SIGNS)),
        machine: HOST_TARGETS.filter((h) => onPath.includes(h)),
      });
      [hosts, hostsFrom, askHosts] = [found.hosts, found.ask ? "default" : "found", found.ask];
    }
    let hooks = input.hooks ?? true;
    const askHooks = input.hooks === undefined;
    if (input.ask && (askHosts || askHooks)) {
      const given = await input.ask({ askHosts, askHooks, defaults: { hosts, hooks } });
      if (!given) return err(MetatorError.usage("setup cancelled", "Nothing was written."));
      [hosts, hooks] = [[...given.hosts], given.hooks];
      if (askHosts) hostsFrom = "asked";
    }
    // Every workflow: unused ones cost nothing, and --workflows narrows.
    const workflows = input.workflows ?? preview.value.workflows;

    const warnings: string[] = [];
    if (d.config.source === undefined) {
      const init = await d.initProject.execute({ dryRun: false, hosts });
      if (init.isErr()) return err(stopped("init", init.error));
      warnings.push(...init.value.warnings);
    } else if (hosts.join() !== d.config.hosts.join()) {
      // Hosts chosen now (--host or the questions) win over the file: saved, comments kept.
      const saved = await d.updateConfig.execute({ hostTargets: hosts });
      if (saved.isErr()) return err(saved.error);
    }
    const now = d.configured();
    if (now.isErr()) return err(now.error);
    const repo = now.value;

    // Setup generates the host files itself, once, after the config and the canon.
    const canon = await repo.installCanon.execute({
      mode,
      theirs: false,
      dryRun: false,
      workflows: [...workflows],
    });
    if (canon.isErr()) return err(stopped(`agents ${mode}`, canon.error));
    warnings.push(...conflictWarnings(canon.value.steps), ...upstreamWarnings(canon.value.removedUpstream));
    const agents = await repo.generateHosts.execute({ check: false, hooks });
    if (agents.isErr()) return err(stopped("generate", agents.error));
    const skills = await repo.generateSkills.execute({ check: false });
    if (skills.isErr()) return err(stopped("generate", skills.error));
    warnings.push(
      ...[...agents.value.orphaned, ...skills.value.orphaned].map(
        (f) => `${f}: generated from an agent or skill that no longer exists; delete it`,
      ),
    );

    if (!hooks)
      warnings.push(
        "hooks are not installed: nothing guards dangerous commands (commit, push, force push), your word in the chat is no consent, and the chat does not hear when you talk to a session. Install them: `metator generate --hooks`",
      );

    // Local state (the index, runs, worktrees) never goes into a commit.
    const ignored = await ignoreLocalState(d.fs);
    if (ignored.isErr()) return err(ignored.error);

    const steps: Record<string, number> = {};
    for (const s of canon.value.steps) steps[s.action] = (steps[s.action] ?? 0) + 1;
    return ok({
      report: {
        config: d.config.source ?? "metator.config.yml",
        hosts,
        hostsFrom,
        workflows: canon.value.workflows,
        hooks,
        canon: { mode, version: canon.value.version, lock: canon.value.lock, steps },
        generated: agents.value.written.length + skills.value.written.length,
        gitignore: ignored.value,
        checks: await this.checks(repo),
        // What a run cannot do here yet (with --gates: whether the quick gate is green before any
        // run), then the daemon the app talks to.
        next: ["metator doctor", "metator doctor --gates", "metator serve"],
      },
      warnings,
    });
  }

  /** The proof the repository is ready for agents: each check passes when it finds no error. */
  private async checks(repo: ConfiguredRepository): Promise<RepositorySetup["checks"]> {
    const clean = (
      r: Result<{ readonly problems: readonly { readonly severity: string }[] }, MetatorError>,
    ) => r.isOk() && !r.value.problems.some((p) => p.severity === "error");
    const hosts = await repo.generateHosts.execute({ check: true, hooks: false });
    const skills = await repo.generateSkills.execute({ check: true });
    const fresh =
      hosts.isOk() &&
      skills.isOk() &&
      hosts.value.stale.length +
        hosts.value.orphaned.length +
        skills.value.stale.length +
        skills.value.orphaned.length ===
        0;
    const passed = [
      clean(await repo.lintAgents.execute()),
      clean(await repo.lintSkills.execute()),
      clean(await repo.lintWorkflows.execute()),
      fresh,
    ];
    return SETUP_CHECKS.map((command, i) => ({ command, passed: passed[i] === true }));
  }
}

/** The step `setup` stopped at, with that step's own error: what a person fixes before running it again. */
function stopped(step: string, e: MetatorError): MetatorError {
  return new MetatorError("COMMAND_FAILED", `setup stopped at \`${step}\`: ${e.message}`, {
    ...(e.hint ? { hint: e.hint } : {}),
    details: { step, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } },
  });
}

/** `.metator/` in `.gitignore`: "added", or "present" when a line already ignores it. */
export async function ignoreLocalState(
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
