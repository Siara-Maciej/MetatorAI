import { WorkerResultDocument } from "../domain/conductor.ts";
import { AnalysisDocument, ResearchDocument } from "../domain/context.ts";
import { QuestionDocument, RunDriverDocument, RunSeenDocument } from "../domain/drive.ts";
import type { MetatorError } from "../domain/errors.ts";
import { EvalReportDocument } from "../domain/eval.ts";
import { FindingSetDocument } from "../domain/finding.ts";
import { GateReportDocument } from "../domain/gate.ts";
import {
  askKinds,
  type CommitReach,
  commitReach,
  commitsAnyway,
  consentsIn,
  DEFAULT_GUARD_CONFIG,
  type GuardConfig,
  guardCommand,
} from "../domain/guard-commands.ts";
import {
  blockResponse,
  COMMIT_DEBUG_CONSENT,
  commandsOfHook,
  contextResponse,
  isEditTool,
  permissionResponse,
  preToolPolicy,
  readHookInput,
  repoRelative,
  touchedPaths,
} from "../domain/hook.ts";
import { PlanDocument, PlanScopeDocument } from "../domain/plan.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { ReviewMetadataDocument } from "../domain/review-metadata.ts";
import { ReviewNotesDocument } from "../domain/review-note.ts";
import { ReviewPlanDocument } from "../domain/review-plan.ts";
import { RunMessageDocument } from "../domain/run-message.ts";
import { RunPointerDocument, RunRecordDocument } from "../domain/run-record.ts";
import { RunHandoffDocument, RunSummaryDocument } from "../domain/run-report.ts";
import type { Unprompted } from "../domain/unprompted.ts";
import { VerdictDocument } from "../domain/verdict.ts";
import { parseJsonDocument, type VersionedDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";
import type { AgentCatalog } from "./agents.ts";
import { parseDocumentText } from "./document-io.ts";
import type { GuardConsents } from "./guard-consents.ts";
import type { TypedBy } from "./pane-typed.ts";
import type { MetatorPaths } from "./paths.ts";
import type { CheckRules } from "./rules.ts";
import type { RunRepository } from "./run-repository.ts";
import type { GetRunStatus, RunView } from "./runs.ts";

/** What a guard prints for the host: a hook response, or nothing (`null`: no opinion). */
export type HookResponse = Record<string, unknown> | null;

/** The active run (status active) and its run directory, or undefined in free mode. */
/** About the host session a hook runs in. */
export interface GuardSession {
  /** Started by `metator run drive`: the drive, not the agent, moves the run. */
  readonly driven?: boolean;
  /**
   * The pane the session runs in under the daemon (METATOR_PANE_ID). A pane is no `run drive`
   * session: its conductor moves the run, its chat starts runs, and a person can be asked there.
   */
  readonly pane?: string;
  /** The run the session belongs to (METATOR_RUN): a pane without one is the chat of no run. */
  readonly run?: string;
  /**
   * For the user-prompt hook: who typed the prompt when the daemon did (`PaneTyped`, read where
   * the daemon keeps it): its own line, or a person's answer to a card. Absent: a person typed it.
   */
  readonly typedBy?: TypedBy;
}

/** What the guards of dangerous commands need (ADR-0094): the config's list and the person's consents. */
export interface CommandGuard {
  readonly guard: GuardConfig;
  readonly consents: Pick<GuardConsents, "valid" | "use" | "grant">;
  /** The debug changes (scratch) a commit would hold: what is staged, and what its command line adds. */
  readonly debugFiles?: (reach: CommitReach) => Promise<readonly string[]>;
  /**
   * What `guard.prompts: metator` judges with: how the repository runs MetatorAI and what its
   * gates run. The package's scripts are read from its `package.json` when a call is judged.
   */
  readonly prompts?: Pick<Unprompted, "metatorCommand" | "gates">;
}

async function activeRun(
  status: Pick<GetRunStatus, "execute">,
): Promise<Result<RunView | undefined, MetatorError>> {
  const view = await status.execute({});
  if (view.isErr()) return view.error.code === "NOT_FOUND" ? ok(undefined) : err(view.error);
  return ok(view.value.status === "active" ? view.value : undefined);
}

/**
 * `guard pre-tool` (PreToolUse, ADR-0038): secrets, destructive commands, push and comments
 * without approval, edits outside plan-scope.json and edits by a coordinator are denied.
 */
export class GuardPreTool {
  constructor(
    private readonly status: Pick<GetRunStatus, "execute">,
    private readonly repo: RunRepository,
    private readonly agents: Pick<AgentCatalog, "scan">,
    private readonly fs: FileSystem,
    private readonly root: string,
    private readonly role: string | undefined,
    private readonly commands?: CommandGuard,
  ) {}

  async execute(raw: unknown, session: GuardSession = {}): Promise<Result<HookResponse, MetatorError>> {
    const hook = readHookInput(raw);
    // The chat a person talks in (an entry pane with no run of its own, ADR-0093) is part of no
    // run: a run that is active in the checkout binds neither its edits nor its commands.
    const chat = session.pane !== undefined && this.role === "apps" && session.run === undefined;
    const run = chat ? ok(undefined) : await activeRun(this.status);
    if (run.isErr()) return err(run.error);
    // A session `run drive` started without a terminal: the drive moves the run, nobody can be asked.
    const driven = session.driven === true && session.pane === undefined;
    const guard = this.commands?.guard ?? DEFAULT_GUARD_CONFIG;
    const who = session.pane ?? hook.sessionId ?? "session";
    const shell = commandsOfHook(hook);
    const guarded = shell.map((argv) => ({ argv, verdict: guardCommand(argv, guard.commands) }));
    // The person's consents and a commit's debug changes are looked up only for a command that asks.
    const asks = guarded.filter((g) => g.verdict.level === "ask");
    let consents: readonly string[] = [];
    let debugFiles: readonly string[] = [];
    if (asks.length > 0 && this.commands) {
      const held = await this.commands.consents.valid(who);
      if (held.isErr()) return err(held.error);
      consents = held.value;
      // The whole line is read: `git add x && git commit` in one call takes x although nothing
      // is staged when the guard is asked.
      const reach = asks.some((g) => g.verdict.kind === "commit")
        ? commitReach(shell, { root: this.root, ...(hook.cwd ? { cwd: hook.cwd } : {}) })
        : undefined;
      if (reach && this.commands.debugFiles) debugFiles = await this.commands.debugFiles(reach);
    }

    let editScope: readonly string[] | undefined;
    if (run.value && isEditTool(hook.tool)) {
      const file = `${this.repo.runDir(run.value.runId)}/plan-scope.json`;
      const text = await this.fs.read(file);
      if (text.isOk()) {
        const scope = parseDocumentText(text.value, file, PlanScopeDocument, "json");
        if (scope.isErr()) return err(scope.error);
        editScope = scope.value.edit;
      }
    }
    // The coordinators that delegate and do not edit: one that has the edit capability (the
    // conversation agent, ADR-0093) edits like any agent.
    const coordinators = new Set(
      (await this.agents.scan()).agents
        .filter((a) => a.agent.role === "coordinator" && !a.agent.capabilities.includes("edit"))
        .map((a) => a.agent.id),
    );
    // `guard.prompts: metator`: what needs no approval prompt is answered here, from the config
    // and the package's own scripts; `host` leaves every such call to the host.
    let unprompted: Omit<Unprompted, "cwd"> | undefined;
    if (guard.prompts === "metator" && this.commands?.prompts)
      unprompted = { root: this.root, ...this.commands.prompts, scripts: await this.packageScripts() };
    const decision = preToolPolicy(hook, {
      root: this.root,
      ...(unprompted ? { unprompted } : {}),
      commands: guard.commands,
      consents,
      debugFiles,
      ...(driven ? { driven: true, headless: true } : {}),
      ...(run.value
        ? {
            run: {
              id: run.value.runId,
              approvals: run.value.approvals,
              driver: run.value.driver?.by ?? "agent",
            },
          }
        : {}),
      ...(editScope ? { editScope } : {}),
      coordinator:
        this.role === "coordinator" ||
        this.role === "conductor" ||
        (hook.agent !== undefined && coordinators.has(hook.agent)),
      ...(this.role === "worker" ? { worker: true } : {}),
    });
    // A consent the person gave in words is used up by the command it lets pass.
    if (decision.consents && decision.consents.length > 0 && this.commands) {
      const used = await this.commands.consents.use(who, decision.consents);
      if (used.isErr()) return err(used.error);
      return ok(permissionResponse(decision));
    }
    // A denial and a question are answers. An allow is one only when the guard gives it on its
    // own (`guard.prompts: metator`): any other "allow" from a PreToolUse hook would skip the
    // host's own permission prompts, so such a call gets no answer and goes to them as usual.
    return ok(decision.decision === "allow" && !decision.unprompted ? null : permissionResponse(decision));
  }

  /** The root package's scripts by name; none when there is no readable `package.json`. */
  private async packageScripts(): Promise<Record<string, string>> {
    const text = await this.fs.read("package.json");
    if (text.isErr()) return {};
    const parsed = parseJsonDocument(text.value, "package.json");
    const scripts = parsed.isOk() ? (parsed.value as { scripts?: unknown } | null)?.scripts : undefined;
    if (typeof scripts !== "object" || scripts === null) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  }
}

/**
 * `guard user-prompt` (UserPromptSubmit, ADR-0094): the person's own message. When it asks in
 * plain words for a command the config guards ("commit", "wypchnij"), that is their consent: kept
 * for this session for a few minutes, for one command of that kind. An agent's words never get
 * here, and a line MetatorAI typed (`[metator] …`) consents to nothing.
 */
export class GuardUserPrompt {
  constructor(
    private readonly consents: Pick<GuardConsents, "grant">,
    private readonly guard: GuardConfig = DEFAULT_GUARD_CONFIG,
  ) {}

  async execute(raw: unknown, session: GuardSession = {}): Promise<Result<HookResponse, MetatorError>> {
    const hook = readHookInput(raw);
    const message = hook.prompt ?? "";
    // A line the daemon typed itself (a relay, a nudge, a notice) reaches this hook like any
    // prompt: it is never a consent. A person's answer to a card, typed for them, is their word.
    if (session.typedBy === "metator") return ok(null);
    const kinds = consentsIn(message, askKinds(this.guard.commands));
    if (kinds.length === 0) return ok(null);
    const granted = [
      ...kinds,
      ...(kinds.includes("commit") && commitsAnyway(message) ? [COMMIT_DEBUG_CONSENT] : []),
    ];
    const saved = await this.consents.grant(
      session.pane ?? hook.sessionId ?? "session",
      granted,
      message,
      this.guard.consentMinutes,
    );
    if (saved.isErr()) return err(saved.error);
    return ok(
      contextResponse(
        "UserPromptSubmit",
        `MetatorAI: the person's message is their consent to ${kinds.join(" and ")}, once, within ${this.guard.consentMinutes} minutes. Run the command now; nothing else is consented.`,
      ),
    );
  }
}

/** `guard post-edit` (PostToolUse): the edited files' rule violations, as context for the model. */
export class GuardPostEdit {
  constructor(
    private readonly checkRules: Pick<CheckRules, "execute">,
    private readonly fs: FileSystem,
    private readonly root: string,
  ) {}

  async execute(raw: unknown, _session: GuardSession = {}): Promise<Result<HookResponse, MetatorError>> {
    const hook = readHookInput(raw);
    if (!isEditTool(hook.tool)) return ok(null);
    const files: string[] = [];
    for (const p of touchedPaths(hook)) {
      const rel = repoRelative(p, this.root);
      if (rel && (await this.fs.exists(rel))) files.push(rel);
    }
    if (files.length === 0) return ok(null);
    // Per-file engines only: typecheck and conformance tests belong to the gates.
    const report = await this.checkRules.execute({ files, engines: ["ast-grep", "biome"] });
    if (report.isErr()) return err(report.error);
    const found = report.value.violations.filter((v) => v.severity === "error" || v.severity === "warning");
    if (found.length === 0) return ok(null);
    const lines = found
      .slice(0, 20)
      .map((v) => `${v.file}:${v.line ?? 1} ${v.canonRuleId ?? v.toolRuleId ?? v.engine}: ${v.message}`);
    return ok(
      contextResponse(
        "PostToolUse",
        `metator rules check found ${found.length} problem(s) in the edited file(s); fix them before going on:\n${lines.join("\n")}`,
      ),
    );
  }
}

/** `guard stop` (Stop): an active run at a non-HITL stage must be advanced or escalated first. */
export class GuardStop {
  constructor(private readonly status: Pick<GetRunStatus, "execute">) {}

  async execute(raw: unknown, session: GuardSession = {}): Promise<Result<HookResponse, MetatorError>> {
    if (readHookInput(raw).stopActive) return ok(null); // never loop: the host already continued once
    if (session.driven) return ok(null); // the drive advances the run when the agent stops
    const run = await activeRun(this.status);
    if (run.isErr()) return err(run.error);
    // Waiting for a human is a legitimate stop.
    if (!run.value || run.value.expects.includes("APPROVE")) return ok(null);
    return ok(
      blockResponse(
        `Run ${run.value.runId} is at stage ${run.value.stage} (expects ${run.value.expects.join(", ")}). ` +
          "Finish the stage and `metator run advance pass`, or `metator run advance fail --reason …` when it cannot pass " +
          "(the run loops back or escalates to a person); `metator run advance abort --reason …` ends the run.",
      ),
    );
  }
}

/** Documents a run directory holds, by kind: the workers' artifacts and the run's own. */
const ARTIFACTS: ReadonlyMap<string, VersionedDocument<unknown>> = new Map(
  [
    FindingSetDocument,
    PlanDocument,
    PlanScopeDocument,
    VerdictDocument,
    GateReportDocument,
    ReviewPlanDocument,
    EvalReportDocument,
    RunRecordDocument,
    RunPointerDocument,
    RunSummaryDocument,
    AnalysisDocument,
    ResearchDocument,
    // What the run itself writes next to the workers' artifacts.
    QuestionDocument,
    RunDriverDocument,
    ReviewMetadataDocument,
    RunHandoffDocument,
    RunMessageDocument,
    RunSeenDocument,
    WorkerResultDocument,
    ReviewNotesDocument,
  ].map((d) => [d.kind, d as VersionedDocument<unknown>]),
);

/** `guard subagent-output` (SubagentStop): every JSON artifact of the run is a valid document. */
export class GuardSubagentOutput {
  constructor(
    private readonly status: Pick<GetRunStatus, "execute">,
    private readonly repo: RunRepository,
    private readonly fs: FileSystem,
  ) {}

  async execute(raw: unknown, _session: GuardSession = {}): Promise<Result<HookResponse, MetatorError>> {
    if (readHookInput(raw).stopActive) return ok(null);
    const run = await activeRun(this.status);
    if (run.isErr()) return err(run.error);
    if (!run.value) return ok(null);
    const problems: string[] = [];
    for (const file of await this.fs.glob([`${this.repo.runDir(run.value.runId)}/**/*.json`])) {
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      const parsed = parseJsonDocument(text.value, file);
      if (parsed.isErr()) {
        problems.push(parsed.error.message);
        continue;
      }
      const kind = (parsed.value as { kind?: unknown } | null)?.kind;
      const doc = typeof kind === "string" ? ARTIFACTS.get(kind) : undefined;
      if (!doc) {
        problems.push(`${file}: unknown or missing kind${typeof kind === "string" ? ` "${kind}"` : ""}`);
        continue;
      }
      const valid = doc.parse(parsed.value, file);
      if (valid.isErr()) problems.push(valid.error.message);
    }
    if (problems.length === 0) return ok(null);
    return ok(
      blockResponse(
        `The run's artifacts are invalid; fix and write them again (\`metator <group> schema\` prints each format):\n${problems.join("\n")}`,
      ),
    );
  }
}

/** `guard session-start` (SessionStart): where the active run stands, so the agent resumes it. */
export class GuardSessionStart {
  constructor(
    private readonly status: Pick<GetRunStatus, "execute">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(): Promise<Result<HookResponse, MetatorError>> {
    const run = await activeRun(this.status);
    if (run.isErr()) return err(run.error);
    const notes: string[] = [];
    if (!(await this.fs.exists(`${this.paths.index}/imports.json`)))
      notes.push("The import index is missing: run `metator index build` before using graph queries.");
    if (run.value) {
      const r = run.value;
      notes.push(
        `Active run ${r.runId} (${r.workflow}): stage ${r.stage}, expects ${r.expects.join(", ")}. ` +
          "Resume it: `metator run status` shows the details.",
      );
    }
    return ok(notes.length === 0 ? null : contextResponse("SessionStart", notes.join("\n")));
  }
}

/** `run checkpoint` / `guard precompact` (PreCompact): the state summary goes into log.md. */
export class CheckpointRun {
  constructor(
    private readonly status: Pick<GetRunStatus, "execute">,
    private readonly repo: RunRepository,
    private readonly now: () => string,
  ) {}

  async execute(input: {
    readonly runId?: string;
  }): Promise<Result<{ readonly runId: string; readonly line: string }, MetatorError>> {
    const view = await this.status.execute(input.runId ? { runId: input.runId } : {});
    if (view.isErr()) return err(view.error);
    const r = view.value;
    const loops = Object.entries(r.loops).map(([k, v]) => `${k} ${v}`);
    const line =
      `${this.now()} · checkpoint · ${r.stage} (${r.status}) · expects ${r.expects.join(", ") || "nothing"}` +
      `${loops.length ? ` · loops ${loops.join(", ")}` : ""}` +
      `${Object.keys(r.approvals).length ? ` · approved ${Object.keys(r.approvals).sort().join(", ")}` : ""}`;
    const logged = await this.repo.appendLog(r.runId, line);
    if (logged.isErr()) return err(logged.error);
    return ok({ runId: r.runId, line });
  }
}
