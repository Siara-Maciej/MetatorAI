import { type AnswerPolicy, policyFrom, policyRefusal } from "../domain/answer-policy.ts";
import { conductorHost } from "../domain/conductor.ts";
import { hostRefusal, labelFor, notDrivable, type Question } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { type RunBrief as Brief, briefOf } from "../domain/inbox.ts";
import { countAttention } from "../domain/overview.ts";
import { endsQuickRun } from "../domain/quick.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { taskWarnings } from "../domain/task-lint.ts";
import type { Clock } from "../ports/index.ts";
import type { ConductorSession, ConductorSessions, DetachedDrive, RunPanes } from "../ports/run-drive.ts";
import type { AnswerPolicyStore } from "./answer-policies.ts";
import type { WorkOverview } from "./overview.ts";
import { type CheckReadiness, RUN_READINESS, readinessWarnings } from "./readiness.ts";
import type { CloseRun } from "./run-close.ts";
import type { RunDrivers } from "./run-drivers.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository, UnreadableRun } from "./run-repository.ts";
import type { AdvanceRun, ApproveRun, GateApprovals, InitRun } from "./runs.ts";
import type { SetupWorktree } from "./worktree-setup.ts";
import type { RemoveWorktree } from "./worktrees.ts";

/**
 * What a person does to a run, once, for every front (ADR-0077): the terminal's commands and the
 * daemon the desktop app talks to call these, so a run starts, is answered, briefed, revived and
 * closed the same way wherever it is asked. A front only reads its input and shapes its output.
 */

type Ok<T> = T extends { execute(...args: never[]): Promise<Result<infer V, MetatorError>> } ? V : never;

export interface DriveStarted {
  readonly stage: string;
  /** False: a live drive already carries the run, and nothing was started. */
  readonly started: boolean;
  readonly host?: string;
}

interface DriveHosts {
  has(host: string): boolean;
  keys(): Iterable<string>;
}

/**
 * `run drive --detach`: the run's drive as a background process. Refused up front where that
 * process would end at once without a word: an escalated run (it names its resume), a run that
 * is not active, a host whose program is not installed.
 */
export class StartDrive {
  constructor(
    private readonly repo: Pick<RunRepository, "load">,
    private readonly hosts: DriveHosts,
    private readonly hostProblem: ((host: string) => string | undefined) | undefined,
    private readonly detached: DetachedDrive,
  ) {}

  async execute(input: {
    readonly runId: string;
    readonly host: string;
    readonly maxSteps?: number;
    /** What the refusal of a finished run says there is nothing to do: `drive`, or `continue`. */
    readonly verb?: "drive" | "continue";
  }): Promise<Result<{ readonly pid: number; readonly stage: string }, MetatorError>> {
    const record = await this.repo.load(input.runId);
    if (record.isErr()) return err(record.error);
    const refused = notDrivable(record.value);
    if (refused) return err(refused);
    if (record.value.state.status !== "active")
      return err(
        new MetatorError(
          "TRANSITION_DENIED",
          `run ${input.runId} is ${record.value.state.status}; there is nothing to ${input.verb ?? "drive"}`,
        ),
      );
    const missing = hostRefusal(input.host, [...this.hosts.keys()], this.hostProblem);
    if (missing) return err(missing);
    const started = await this.detached.start({
      runId: input.runId,
      host: input.host,
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    });
    return started.map((d) => ({ ...d, stage: record.value.state.stage }));
  }
}

/**
 * Makes sure an active run has a live drive (`run continue`, the supervisor, an answer nobody
 * waits for): nothing when one is alive, else a new one on the host named, else the host the run
 * used, else the default. An escalated run is never driven on: resuming it is a person's own,
 * explicit act (`ResumeRun`), so this refuses it with the way out.
 */
export class EnsureDriven {
  constructor(
    private readonly repo: Pick<RunRepository, "load">,
    private readonly drivers: Pick<RunDrivers, "status">,
    private readonly hosts: DriveHosts,
    private readonly defaultHost: () => string,
    private readonly startDrive: Pick<StartDrive, "execute">,
  ) {}

  async execute(input: {
    readonly runId: string;
    readonly host?: string;
    readonly maxSteps?: number;
  }): Promise<Result<DriveStarted, MetatorError>> {
    const record = await this.repo.load(input.runId);
    if (record.isErr()) return err(record.error);
    const refused = notDrivable(record.value);
    if (refused) return err(refused);
    const driver = await this.drivers.status(input.runId);
    if (driver.isErr()) return err(driver.error);
    if (record.value.state.status === "active" && driver.value?.alive)
      return ok({ stage: record.value.state.stage, started: false });
    const used = record.value.host;
    const host = input.host || (used && this.hosts.has(used) ? used : this.defaultHost());
    const started = await this.startDrive.execute({
      runId: input.runId,
      host,
      verb: "continue",
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    });
    return started.map((d) => ({ stage: d.stage, started: true, host }));
  }
}

export interface StartRunInput {
  readonly workflow: string;
  readonly task: string;
  readonly autonomy?: "L0" | "L1" | "L2";
  /** Work in a new worktree (with its own ports), branched from `base`. */
  readonly worktree?: { readonly base?: string; readonly allowDirty?: boolean };
  /** In this checkout: start although tracked files have uncommitted changes. */
  readonly allowDirty?: boolean;
  /** Work in the worktree an earlier run made, on the uncommitted work it left there. */
  readonly adopt?: { readonly id: string; readonly path: string; readonly branch: string };
  readonly parent?: string;
  readonly inputs?: Readonly<Record<string, string>>;
  /** The system plan's step this run carries out (a child of a system run, F7.6). */
  readonly system?: { readonly plan: string; readonly step: string; readonly app: string };
  /** False: leave a new worktree without its dependencies (`worktree setup` later). */
  readonly setup?: boolean;
  /** Stop once the plan is approved: the run ends `planned` (ADR-0096). */
  readonly until?: "plan";
  /** Take the approved plan of an earlier run: start at `build`, or at its review. */
  readonly planFrom?: { readonly run: string; readonly from: "build" | "review" };
  /** Also drive the run in the background, on this host (empty: the default). */
  readonly drive?: { readonly host?: string };
  /**
   * Open the run as a conductor session a person sees (ADR-0090), on this interactive host when it
   * is installed, else the first installed of `supervisor.hostOrder`. With no daemon serving the
   * repository, or no interactive host installed, the run is driven in the background instead
   * (on this host, else the default), and `noSession` says why.
   */
  readonly session?: { readonly host?: string };
}

/** What StartRun needs to open a run's conductor session where a person sees it. */
export interface VisibleSessions {
  readonly sessions: ConductorSessions;
  /** The interactive hosts in `supervisor.hostOrder`, each with whether it is installed here. */
  readonly hosts: () => readonly { readonly id: string; readonly installed: boolean }[];
  readonly journal: Pick<RunJournal, "record">;
}

export interface StartedRun {
  readonly run: Ok<InitRun>;
  /** The worktree's dependencies, when it has a worktree and setup was not declined. */
  readonly setup?: Ok<SetupWorktree>;
  readonly setupError?: string;
  readonly drive?: DriveStarted;
  readonly driveError?: { readonly message: string; readonly hint?: string };
  /** Its conductor session, when one was asked for and opened. */
  readonly session?: ConductorSession;
  /** Why a session asked for was not opened (the run is driven in the background instead). */
  readonly noSession?: string;
  /** What this run will not do here, how full the person's hands are, what the task lacks. */
  readonly warnings: readonly string[];
}

/**
 * A new run, the same from every front: the run itself, its worktree's dependencies (always,
 * unless declined: its tests and gates run there), what it will not be able to do here, a word
 * when too many runs already wait for a person, and its drive when one is asked for.
 */
export class StartRun {
  constructor(
    private readonly init: Pick<InitRun, "execute">,
    private readonly setupWorktree: Pick<SetupWorktree, "execute">,
    private readonly readiness: Pick<CheckReadiness, "execute">,
    private readonly overview: Pick<WorkOverview, "execute">,
    private readonly ensureDriven: Pick<EnsureDriven, "execute">,
    /** `supervisor.wipLimit`: the runs that may wait for a person before a new one is a warning. */
    private readonly wipLimit: number,
    /** Where a run's conductor session opens; without it, a session asked for is a drive. */
    private readonly visible?: VisibleSessions,
  ) {}

  async execute(input: StartRunInput): Promise<Result<StartedRun, MetatorError>> {
    const started = await this.init.execute({
      workflow: input.workflow,
      task: input.task,
      ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {}),
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.worktree ? { worktree: input.worktree } : input.allowDirty ? { allowDirty: true } : {}),
      ...(input.adopt ? { adopt: input.adopt } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.until ? { until: input.until } : {}),
      ...(input.planFrom ? { planFrom: input.planFrom } : {}),
    } as Parameters<InitRun["execute"]>[0]);
    if (started.isErr()) return err(started.error);
    const run = started.value;
    const setup =
      run.worktree && input.setup !== false
        ? await this.setupWorktree.execute({ run: run.runId })
        : undefined;
    const ready = await this.readiness.execute(run.worktree ? { worktree: run.worktree.id } : {});
    const overview = await this.overview.execute();
    // The run just started is one of them only if it already waits; the others were there before.
    const waiting = overview.isOk() ? countAttention(overview.value.runs).you : 0;
    const seen = input.session || input.drive ? await this.see(run.runId, input) : undefined;
    if (seen?.isErr()) return err(seen.error);
    const { session, noSession, drive, driveError } = seen?.isOk() ? seen.value : {};
    return ok({
      run,
      ...(session ? { session } : {}),
      ...(noSession ? { noSession } : {}),
      ...(setup?.isOk() ? { setup: setup.value } : {}),
      ...(setup?.isErr() ? { setupError: setup.error.message } : {}),
      ...(drive ? { drive } : {}),
      ...(driveError ? { driveError } : {}),
      warnings: [
        ...(waiting >= this.wipLimit
          ? [
              `attention: ${waiting} run(s) already wait for a person (limit ${this.wipLimit}): answer them first (metator inbox), or raise supervisor.wipLimit`,
            ]
          : []),
        ...taskWarnings(input.task),
        ...(setup?.isErr() ? [`worktree setup: ${setup.error.message}`] : []),
        ...(ready.isOk() ? readinessWarnings(ready.value, RUN_READINESS) : []),
      ],
    });
  }

  /**
   * A run already made, put where it works: its conductor session a person sees (`session`), else
   * (or when `drive` is asked) a background drive; the run's activity says which and why.
   */
  async see(
    runId: string,
    input: Pick<StartRunInput, "session" | "drive">,
  ): Promise<Result<Pick<StartedRun, "session" | "noSession" | "drive" | "driveError">, MetatorError>> {
    const opened = input.session ? await this.openSession(runId, input.session.host) : undefined;
    // A session that could not open leaves the run to a background drive: it never just stands.
    const driveHost = input.drive ? input.drive.host : input.session?.host;
    const drive =
      input.drive || (opened && "noSession" in opened)
        ? await this.ensureDriven.execute({ runId, ...(driveHost ? { host: driveHost } : {}) })
        : undefined;
    if (opened) {
      const said =
        "session" in opened
          ? `started as a conductor session in pane ${opened.session.paneId} on ${opened.session.host}`
          : `no conductor session (${opened.noSession}): ${
              drive?.isOk()
                ? `driven in the background on ${drive.value.host ?? "its host"}`
                : `not driven either: ${drive?.isErr() ? drive.error.message : "no drive"}`
            }`;
      const noted = await this.visible?.journal.record(runId, { type: "drive", text: said });
      if (noted?.isErr()) return err(noted.error);
    }
    return ok({
      ...(opened && "session" in opened ? { session: opened.session } : {}),
      ...(opened && "noSession" in opened ? { noSession: opened.noSession } : {}),
      ...(drive?.isOk() ? { drive: drive.value } : {}),
      ...(drive?.isErr()
        ? {
            driveError: {
              message: drive.error.message,
              ...(drive.error.hint ? { hint: drive.error.hint } : {}),
            },
          }
        : {}),
    });
  }

  /** The run's conductor session, or why there is none: no daemon, no interactive host, or it failed. */
  private async openSession(
    runId: string,
    preferred: string | undefined,
  ): Promise<{ readonly session: ConductorSession } | { readonly noSession: string }> {
    if (!this.visible) return { noSession: "no daemon serves this repository" };
    const hosts = this.visible.hosts();
    const host = conductorHost(preferred, hosts);
    if (!host)
      return {
        noSession: `no interactive host is installed here (${hosts.map((h) => h.id).join(", ") || "none known"})`,
      };
    const opened = await this.visible.sessions.open({ runId, host });
    return opened.isOk() ? { session: opened.value } : { noSession: opened.error.message };
  }
}

export interface AnswerInput {
  readonly runId?: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly text?: string;
  readonly by: string;
  /** Also answer every such question this way from now on (an answer policy). */
  readonly always?: boolean;
  /** `inbox`: answered from the decision card, without opening the session (11a). */
  readonly origin?: "inbox";
  /** Start a drive when the answered run is active and nothing carries it. */
  readonly drive?: boolean;
}

export type Answered = Question & {
  readonly policy?: AnswerPolicy;
  readonly drive?: { readonly started: boolean } | { readonly error: string };
};

/**
 * A person's answer to a run's question, the same from every front: recorded under their name,
 * made a policy when they say `always` (refused where a policy may not answer), and carried out:
 * an active run that nothing drives gets its drive again. An escalated run is never resumed by an
 * answer; that takes a named person's own resume.
 */
export class AnswerQuestion {
  constructor(
    private readonly repo: Pick<RunRepository, "resolveId" | "load">,
    private readonly journal: Pick<RunJournal, "questions" | "answer">,
    private readonly policies: Pick<AnswerPolicyStore, "list" | "add">,
    private readonly drivers: Pick<RunDrivers, "status">,
    private readonly ensureDriven: Pick<EnsureDriven, "execute">,
    private readonly clock: Clock,
    /** A live terminal session of the run: the agent there reads the answer itself. */
    private readonly liveSession: (runId: string) => boolean = () => false,
    /**
     * A human gate's question nothing drives decides the gate here: Approve as
     * `run approve` does, anything else sends the run back with the person's words.
     */
    private readonly gates?: {
      readonly approve: Pick<ApproveRun, "execute">;
      readonly advance: Pick<AdvanceRun, "execute">;
      /** Why the gate cannot be approved now (its system plan's lint errors), or undefined. */
      readonly refusal?: GateApprovals["refusal"];
    },
    /**
     * A question a pane asked (`HostPrompts`): settled before the answer is recorded (answered in
     * the pane already, or a person at its keyboard), and typed into it right after.
     */
    private readonly terminal?: {
      settle(runId: string, question: string, by: string): Promise<Result<void, MetatorError>>;
      deliver(runId: string, question: string): Promise<Result<void, MetatorError>>;
    },
  ) {}

  async execute(input: AnswerInput): Promise<Result<Answered, MetatorError>> {
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const runId = id.value;
    if (input.choices.length === 0 && !input.text)
      return err(MetatorError.usage("an answer needs a choice or your own words"));
    let choices = [...input.choices];
    // A human gate the run stands at: its answer decides the gate (below); an Approve the gate
    // refuses now (a system plan with lint errors) is refused before anything is recorded.
    const gate = this.gates ? await this.openGate(runId, input.question) : undefined;
    let text = input.text;
    if (gate && this.gates?.refusal && choices.includes("Approve")) {
      const refused = await this.gates.refusal(runId, gate);
      if (refused.isErr()) return err(refused.error);
      if (refused.value) return err(refused.value);
    } else if (gate && this.gates?.refusal && choices.includes("Reject")) {
      // Sent back while the plan has lint errors: the planner hears them with the person's words.
      const refused = await this.gates.refusal(runId, gate);
      if (refused.isOk() && refused.value)
        text = text ? `${text}\n${refused.value.message}` : refused.value.message;
    }
    if (input.always) {
      const all = await this.journal.questions(runId);
      if (all.isErr()) return err(all.error);
      const q = all.value.find((x) => x.id === input.question);
      if (!q) return err(MetatorError.notFound(`question ${input.question} of run ${runId}`));
      // The policy is judged and written with the labels the question has, however they were typed.
      const labels = q.options.map((o) => o.label);
      choices = choices.map((choice) => labelFor(labels, choice));
      const refused = policyRefusal(q, choices.length > 0 ? choices : ["Other"]);
      if (refused) return err(MetatorError.usage(`no policy: ${refused}`, "Answer without --always."));
    }
    const answer = { choices, ...(text ? { text: text } : {}) };
    if (this.terminal) {
      const settled = await this.terminal.settle(runId, input.question, input.by);
      if (settled.isErr()) return err(settled.error);
    }
    const answered = await this.journal.answer(runId, input.question, {
      ...answer,
      by: input.by,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    if (answered.isErr()) return err(answered.error);
    // The pane that asked gets the answer now, not on the next check.
    if (this.terminal) {
      const delivered = await this.terminal.deliver(runId, input.question);
      if (delivered.isErr()) return err(delivered.error);
    }
    let policy: AnswerPolicy | undefined;
    if (input.always) {
      const taken = await this.policies.list();
      if (taken.isErr()) return err(taken.error);
      const added = await this.policies.add(
        policyFrom(
          answered.value,
          answer,
          input.by,
          this.clock.now().toISOString(),
          taken.value.map((p) => p.id),
        ),
      );
      if (added.isErr()) return err(added.error);
      policy = added.value;
    }
    // A live drive waits on the question and carries the answer out itself (its own FAIL or
    // approval, said in its activity); only a gate nothing drives is decided here.
    if (gate && this.gates && !(await this.drivenNow(runId))) {
      const decided = choices.includes("Approve")
        ? await this.gates.approve.execute({
            runId,
            gate,
            by: input.by,
            ...(text ? { choice: text } : {}),
          })
        : await this.gates.advance.execute({
            runId,
            event: { type: "FAIL", reason: text ?? `rejected by ${input.by}` },
          });
      // A drive that waited on the question may have carried the answer out first: nothing twice.
      if (decided.isErr() && decided.error.code !== "TRANSITION_DENIED") return err(decided.error);
    }
    // The card that ends a quick run (ADR-0093): `Fine` ends it here, whoever looks on (a
    // conductor at rest would never hear of it), and no drive starts for one advance. Only a live
    // drive, which waits on its gate, ends the run itself.
    if (endsQuickRun(answered.value) && this.gates && !(await this.drivenNow(runId))) {
      const record = await this.repo.load(runId);
      if (
        record.isOk() &&
        record.value.state.status === "active" &&
        record.value.state.stage === answered.value.stage
      ) {
        const ended = await this.gates.advance.execute({ runId, event: { type: "PASS" } });
        if (ended.isErr() && ended.error.code !== "TRANSITION_DENIED") return err(ended.error);
      }
    }
    const drive = input.drive ? await this.carryOn(runId) : undefined;
    return ok({ ...answered.value, ...(policy ? { policy } : {}), ...(drive ? { drive } : {}) });
  }

  /** The stage of the gate this question decides: an open gate question of the stage the run stands at. */
  private async openGate(runId: string, question: string): Promise<string | undefined> {
    const all = await this.journal.questions(runId);
    const q = all.isOk() ? all.value.find((x) => x.id === question) : undefined;
    if (!q || q.answer || q.source !== "gate") return undefined;
    const record = await this.repo.load(runId);
    if (record.isErr() || record.value.state.status !== "active" || record.value.state.stage !== q.stage)
      return undefined;
    return q.stage;
  }

  /** A live drive carries the run now. */
  private async drivenNow(runId: string): Promise<boolean> {
    const driver = await this.drivers.status(runId);
    return driver.isOk() && driver.value?.alive === true;
  }

  /** The drive of an active run that nothing carries; nothing for any other run. */
  private async carryOn(
    runId: string,
  ): Promise<{ readonly started: boolean } | { readonly error: string } | undefined> {
    const record = await this.repo.load(runId);
    if (record.isErr() || record.value.state.status !== "active") return undefined;
    const driver = await this.drivers.status(runId);
    if (driver.isOk() && driver.value?.alive) return undefined;
    if (this.liveSession(runId)) return undefined;
    const started = await this.ensureDriven.execute({ runId });
    return started.isOk() ? { started: started.value.started } : { error: started.error.message };
  }
}

export type BriefOfRun = Brief & {
  readonly runId: string;
  readonly status: string;
  readonly stage: string;
};

/**
 * What happened in a run since the person last looked (`run brief`): from the time they name,
 * else their last brief, else the run's start. A time that is not one is a usage error on every
 * front; the run is marked as read unless they only peek.
 */
export class BriefRun {
  constructor(
    private readonly repo: Pick<RunRepository, "resolveId" | "load">,
    private readonly journal: Pick<RunJournal, "seen" | "markSeen" | "activity">,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly since?: string;
    readonly peek?: boolean;
  }): Promise<Result<BriefOfRun, MetatorError>> {
    if (input.since !== undefined && Number.isNaN(Date.parse(input.since)))
      return err(MetatorError.usage(`since ${input.since}: expected an ISO time`));
    const id = await this.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const seen = await this.journal.seen(id.value);
    if (seen.isErr()) return err(seen.error);
    const record = await this.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const since =
      input.since !== undefined
        ? new Date(input.since).toISOString()
        : (seen.value ?? record.value.createdAt);
    const activity = await this.journal.activity(id.value);
    if (activity.isErr()) return err(activity.error);
    if (!input.peek) {
      const marked = await this.journal.markSeen(id.value);
      if (marked.isErr()) return err(marked.error);
    }
    return ok({
      runId: id.value,
      status: record.value.state.status,
      stage: record.value.state.stage,
      ...briefOf(activity.value, since),
    });
  }
}

export interface Revived {
  readonly revived: readonly { readonly runId: string; readonly stage: string; readonly died: number }[];
  /** Runs whose record cannot be read: skipped among all runs, said to the person. */
  readonly unreadable: readonly UnreadableRun[];
}

/**
 * `run revive`: every drive that died (a restart, a killed process) is started again at the stage
 * it stood. A run nobody drove, or whose drive left on purpose, is left alone; safe to schedule.
 */
export class ReviveRuns {
  constructor(
    private readonly repo: Pick<RunRepository, "list" | "load" | "stateFile">,
    private readonly drivers: Pick<RunDrivers, "status">,
    private readonly journal: Pick<RunJournal, "record">,
    private readonly ensureDriven: Pick<EnsureDriven, "execute">,
  ) {}

  async execute(input: { readonly runId?: string }): Promise<Result<Revived, MetatorError>> {
    const ids = input.runId ? [input.runId] : await this.repo.list();
    const revived: { runId: string; stage: string; died: number }[] = [];
    const unreadable: UnreadableRun[] = [];
    for (const runId of ids) {
      const record = await this.repo.load(runId);
      if (record.isErr()) {
        // The run a person named is their answer; among all runs, one broken record is skipped and said.
        if (input.runId) return err(record.error);
        unreadable.push({ runId, file: this.repo.stateFile(runId), message: record.error.message });
        continue;
      }
      if (record.value.state.status !== "active") continue;
      const driver = await this.drivers.status(runId);
      if (driver.isErr()) return err(driver.error);
      // No file: nobody drove it, or its drive left on purpose (done, stopped, a host limit).
      if (!driver.value || driver.value.alive) continue;
      const logged = await this.journal.record(runId, {
        type: "drive",
        text: `revived: its drive (process ${driver.value.pid}) had died`,
      });
      if (logged.isErr()) return err(logged.error);
      const resumed = await this.ensureDriven.execute({ runId });
      if (resumed.isErr()) return err(resumed.error);
      revived.push({ runId, stage: resumed.value.stage, died: driver.value.pid });
    }
    return ok({ revived, unreadable });
  }
}

export type EndedRun = Ok<CloseRun> & {
  readonly panes?: { readonly closed: number; readonly workspace?: string };
  readonly worktree?: { readonly id: string; readonly path: string; readonly removed: true };
};

/**
 * `run close`, the same from every front: the summary of a finished run (with a reason, an active
 * or escalated one is aborted first), its panes closed, and its worktree removed when asked.
 */
export class EndRun {
  constructor(
    private readonly close: Pick<CloseRun, "execute">,
    private readonly repo: Pick<RunRepository, "load">,
    private readonly panes: RunPanes,
    private readonly removeWorktree: Pick<RemoveWorktree, "execute">,
  ) {}

  async execute(input: {
    readonly runId?: string;
    readonly abortReason?: string;
    readonly removeWorktree?: boolean;
    /** Remove the worktree even with uncommitted changes. */
    readonly force?: boolean;
  }): Promise<Result<EndedRun, MetatorError>> {
    const closed = await this.close.execute({
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.abortReason ? { abortReason: input.abortReason } : {}),
    });
    if (closed.isErr()) return err(closed.error);
    const runId = closed.value.runId;
    // The run's panes go with it (R5), where something holds them; its worktree only when asked.
    const panes = await this.panes.closeRun(runId);
    const record = await this.repo.load(runId);
    let worktree: EndedRun["worktree"];
    if (input.removeWorktree && record.isOk() && record.value.worktree) {
      const removed = await this.removeWorktree.execute({
        id: record.value.worktree.id,
        force: input.force === true,
      });
      if (removed.isErr()) return err(removed.error);
      worktree = { id: removed.value.id, path: removed.value.path, removed: true };
    }
    return ok({
      ...closed.value,
      ...(panes.isOk() ? { panes: panes.value } : {}),
      ...(worktree ? { worktree } : {}),
    });
  }
}
