import { z } from "zod";
import { MetatorError } from "../domain/errors.ts";
import {
  type Escalator,
  endsQuickRun,
  NEVER_OVERRIDDEN,
  QUICK_ASKER,
  QUICK_GREW_PROMPT,
  QUICK_OPTIONS,
  QUICK_READY_PROMPT,
  type QuickVerdict,
  quickOverride,
  quickReviewFindings,
} from "../domain/quick.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { defineDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem, WorkingTree } from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";
import { emptyGateHint } from "./gate.ts";
import type { CloseRun } from "./run-close.ts";
import type { RunJournal } from "./run-journal.ts";
import type { StartedRun, StartRun } from "./run-operations.ts";
import type { RunRepository } from "./run-repository.ts";
import type { AdvanceRun } from "./runs.ts";

/**
 * What a person kept quick in a quick run although an escalator tripped (`<run>/quick.json`,
 * ADR-0093): which escalators, who, and in which words. The check after the build does not ask
 * again about what is here.
 */
export const QuickRunDocument = defineDocument("QuickRun", {
  latest: z.strictObject({
    overrides: z.array(
      z.strictObject({
        escalators: z.array(z.string().min(1)).min(1),
        by: z.string().min(1),
        /** The person's sentence, when they gave one (`quick start --override`). */
        words: z.string().optional(),
        at: z.iso.datetime(),
      }),
    ),
  }),
  hint: "Written by `metator quick start --override` and by the answer to the card `This grew past quick`.",
});

type QuickOverride = { escalators: string[]; by: string; words?: string | undefined; at: string };

/** The workflow a quick change continues in when it grew: across repositories, the system one. */
export const fullWorkflowFor = (escalators: readonly Pick<Escalator, "id">[]): string =>
  escalators.some((e) => e.id === "cross-repository") ? "mt-system-change" : "mt-feature";

const said = (escalators: readonly Pick<Escalator, "id" | "why">[]): string =>
  escalators.map((e) => `${e.id} (${e.why})`).join("; ");

type Journal = Pick<RunJournal, "ask" | "questions" | "record">;

/** What was kept quick in a run although an escalator tripped: the run's `quick.json` and its activity. */
export class QuickOverrides {
  constructor(
    private readonly fs: Pick<FileSystem, "read" | "write" | "exists">,
    private readonly repo: Pick<RunRepository, "runDir">,
    private readonly journal: Pick<RunJournal, "record">,
    private readonly clock: Clock,
  ) {}

  private file(runId: string): string {
    return `${this.repo.runDir(runId)}/quick.json`;
  }

  /** The escalators already kept quick in this run. */
  async kept(runId: string): Promise<Result<readonly string[], MetatorError>> {
    const file = this.file(runId);
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseDocumentText(text.value, file, QuickRunDocument, "json").map((d) =>
      d.overrides.flatMap((o) => o.escalators),
    );
  }

  /** The person keeps it quick although these tripped: in the run's file and in its activity. */
  async keep(
    runId: string,
    stage: string,
    escalators: readonly Pick<Escalator, "id" | "why">[],
    by: string,
    words?: string,
  ): Promise<Result<void, MetatorError>> {
    const file = this.file(runId);
    let overrides: QuickOverride[] = [];
    if (await this.fs.exists(file)) {
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const doc = parseDocumentText(text.value, file, QuickRunDocument, "json");
      if (doc.isErr()) return err(doc.error);
      overrides = doc.value.overrides;
    }
    const saved = await this.fs.write(
      file,
      serializeJsonDocument(
        QuickRunDocument.stamp({
          overrides: [
            ...overrides,
            {
              escalators: escalators.map((e) => e.id),
              by,
              ...(words ? { words } : {}),
              at: this.clock.now().toISOString(),
            },
          ],
        }),
      ),
    );
    if (saved.isErr()) return err(saved.error);
    return this.journal.record(runId, {
      type: "gate",
      stage,
      text: `quick although ${said(escalators)}: ${by} keeps it quick${words ? `: "${words}"` : ""}`,
    });
  }
}

export interface QuickRunDependencies {
  readonly start: Pick<StartRun, "execute">;
  readonly repo: Pick<RunRepository, "load" | "runDir">;
  readonly journal: Journal;
  readonly overrides: Pick<QuickOverrides, "kept" | "keep">;
  /** The checkout: its tracked files with uncommitted changes (undefined: no git here). */
  readonly tree: Pick<WorkingTree, "modifiedTracked">;
  /** The repository's quick gate: how many steps it has, and the config file that says so. */
  readonly quickGate?: { readonly steps: number; readonly source: string | undefined };
}

export interface QuickStarted {
  readonly runId: string;
  readonly started: StartedRun;
  readonly session?: StartedRun["session"];
  /** The escalators the person's sentence lifted. */
  readonly overridden?: readonly string[];
}

/**
 * `metator quick start` (ADR-0093): a small change as an `mt-quick` run with its conductor in a
 * terminal of its own. Refused while an escalator trips, unless the person keeps it quick in one
 * sentence (recorded with the run in their words); never when it reaches another repository. A
 * checkout with uncommitted changes asks where: in it, or in a worktree of its own.
 */
export class QuickStart {
  constructor(private readonly d: QuickRunDependencies) {}

  async execute(input: {
    readonly task: string;
    /** `quick check` of the files the change is expected to touch; without files, nothing tripped yet. */
    readonly check?: Pick<QuickVerdict, "escalators">;
    /** The person's sentence that keeps it quick although escalators tripped. */
    readonly override?: string;
    readonly where?: "here" | "worktree";
    readonly host?: string;
  }): Promise<Result<QuickStarted, MetatorError>> {
    const escalators = input.check?.escalators ?? [];
    const allowed = quickOverride(escalators, input.override);
    if (!allowed.allowed) return err(new MetatorError("USAGE", allowed.why, { details: { escalators } }));
    // The workflow's gate stage is `metator gate quick`: with no step configured the run would
    // stop there right after its build, so it is refused before anything starts.
    if (this.d.quickGate && this.d.quickGate.steps === 0)
      return err(
        new MetatorError(
          "INVALID_CONFIG",
          "the quick gate has no steps: a quick run (mt-quick) checks its change with `metator gate quick` and would stop there",
          { hint: emptyGateHint("quick", this.d.quickGate.source) },
        ),
      );
    const dirty = (await this.d.tree.modifiedTracked()) ?? [];
    if (dirty.length > 0 && !input.where)
      return err(
        MetatorError.usage(
          "dirty: pass --here or --worktree",
          `The checkout has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}): --here works in it (they become part of the change), --worktree in a worktree of its own from the last commit. Ask the person which.`,
        ),
      );
    const started = await this.d.start.execute({
      workflow: "mt-quick",
      task: input.task,
      ...(input.where === "worktree"
        ? { worktree: dirty.length > 0 ? { allowDirty: true } : {} }
        : dirty.length > 0
          ? { allowDirty: true }
          : {}),
      session: input.host ? { host: input.host } : {},
    });
    if (started.isErr()) return err(started.error);
    const run = started.value.run;
    if (allowed.overridden) {
      const kept = await this.d.overrides.keep(
        run.runId,
        run.stage,
        escalators,
        "the person",
        (input.override as string).trim(),
      );
      if (kept.isErr()) return err(kept.error);
    }
    return ok({
      runId: run.runId,
      started: started.value,
      ...(started.value.session ? { session: started.value.session } : {}),
      ...(allowed.overridden ? { overridden: allowed.overridden } : {}),
    });
  }
}

export type QuickFitOutcome =
  /** The diff is within a quick change, or the person kept it quick. */
  | { readonly state: "fits" }
  /** The card is open: nothing moves until the person answers. */
  | { readonly state: "waiting"; readonly question: string; readonly escalators: readonly Escalator[] }
  /** A full run took the change over; the quick run is closed. */
  | { readonly state: "full"; readonly run: string; readonly workflow: string };

/**
 * `metator quick fit`, the gate after the build: the real diff against the limits. Past them the
 * person decides on one card, `This grew past quick: <which>`: continue as full (a full run takes
 * the diff over where it is, the quick run closes) or keep as quick (recorded). Across
 * repositories only the first is offered.
 */
export class QuickFit {
  constructor(
    private readonly d: QuickRunDependencies & {
      readonly close: Pick<CloseRun, "execute">;
      /** The worktree of a quick run now belongs to the run that continues it (the registry). */
      readonly adopted?: (worktree: string, run: string) => Promise<Result<void, MetatorError>>;
    },
  ) {}

  async execute(input: {
    readonly runId: string;
    readonly verdict: Pick<QuickVerdict, "escalators">;
  }): Promise<Result<QuickFitOutcome, MetatorError>> {
    const run = await this.d.repo.load(input.runId);
    if (run.isErr()) return err(run.error);
    const kept = await this.d.overrides.kept(input.runId);
    if (kept.isErr()) return err(kept.error);
    const tripped = input.verdict.escalators.filter((e) => !kept.value.includes(e.id));
    if (tripped.length === 0) return ok({ state: "fits" });
    const prompt = `${QUICK_GREW_PROMPT}${said(tripped)}`;
    // The card as it was last asked: its answer is acted on once (what was kept is no longer
    // tripped, a run continued as full is closed), so reading it again on the next poll is safe.
    const all = await this.d.journal.questions(input.runId);
    if (all.isErr()) return err(all.error);
    const last = all.value.filter((q) => q.prompt === prompt).at(-1);
    const answer = last?.answer;
    if (
      answer &&
      (answer.choices.includes(QUICK_OPTIONS.keep) || answer.choices.includes(QUICK_OPTIONS.full))
    )
      return this.decided(input.runId, tripped, answer.choices, answer.by);
    // Not asked yet, or answered in the person's own words (which decide nothing): the card.
    const hard = tripped.some((e) => (NEVER_OVERRIDDEN as readonly string[]).includes(e.id));
    const asked = await this.d.journal.ask(input.runId, {
      stage: run.value.state.stage,
      source: "agent",
      agent: QUICK_ASKER,
      prompt,
      options: [
        {
          label: QUICK_OPTIONS.full,
          description: `A ${fullWorkflowFor(tripped)} run takes the change over as it is: plan, gates, review, delivery`,
        },
        ...(hard
          ? []
          : [{ label: QUICK_OPTIONS.keep, description: "Finish it as quick: one short review, no plan" }]),
      ],
      multiSelect: false,
    });
    if (asked.isErr()) return err(asked.error);
    return ok({ state: "waiting", question: asked.value.id, escalators: tripped });
  }

  /** What the person chose on the card. */
  private async decided(
    runId: string,
    tripped: readonly Escalator[],
    choices: readonly string[],
    by: string,
  ): Promise<Result<QuickFitOutcome, MetatorError>> {
    const run = await this.d.repo.load(runId);
    if (run.isErr()) return err(run.error);
    if (choices.includes(QUICK_OPTIONS.keep)) {
      const kept = await this.d.overrides.keep(runId, run.value.state.stage, tripped, by);
      if (kept.isErr()) return err(kept.error);
      return ok({ state: "fits" });
    }
    const workflow = fullWorkflowFor(tripped);
    const started = await this.d.start.execute({
      workflow,
      task: `${run.value.task}\n\n(continues quick run ${runId}, which grew past quick: ${said(tripped)}; its uncommitted diff is the work so far)`,
      // The diff stays where it is: the full run starts on top of it.
      ...(run.value.worktree ? { adopt: run.value.worktree } : { allowDirty: true }),
      session: {},
    });
    if (started.isErr()) return err(started.error);
    const full = started.value.run.runId;
    if (run.value.worktree && this.d.adopted) {
      const moved = await this.d.adopted(run.value.worktree.id, full);
      if (moved.isErr()) return err(moved.error);
    }
    const closed = await this.d.close.execute({ runId, abortReason: `continued as full: run ${full}` });
    if (closed.isErr()) return err(closed.error);
    return ok({ state: "full", run: full, workflow });
  }
}

export type QuickReadyOutcome =
  | { readonly state: "waiting"; readonly question: string }
  /** The person said Fine; `run` is the run's status now (`done` unless a drive ends it itself). */
  | { readonly state: "fine"; readonly by: string; readonly run: string };

/**
 * `metator quick ready`, the gate that ends a quick run: one card, `Quick change ready: look at
 * the diff`. `Open diff` is what an app does with it (it shows the run's changes); `Fine` is the
 * answer that ends the run: the run ends here, unless a drive carries it (the drive passes its
 * gate and ends it itself). The diff stays uncommitted.
 */
export class QuickReady {
  constructor(
    private readonly d: {
      readonly repo: Pick<RunRepository, "load">;
      readonly journal: Pick<RunJournal, "ask" | "questions">;
      readonly advance: Pick<AdvanceRun, "execute">;
      /** Whether a live drive carries the run now. */
      readonly driven: (runId: string) => Promise<boolean>;
    },
  ) {}

  async execute(input: { readonly runId: string }): Promise<Result<QuickReadyOutcome, MetatorError>> {
    const run = await this.d.repo.load(input.runId);
    if (run.isErr()) return err(run.error);
    const all = await this.d.journal.questions(input.runId);
    if (all.isErr()) return err(all.error);
    const fine = all.value.find(endsQuickRun);
    if (fine?.answer) {
      const state = run.value.state;
      if (state.status === "active" && state.stage === fine.stage && !(await this.d.driven(input.runId))) {
        const ended = await this.d.advance.execute({ runId: input.runId, event: { type: "PASS" } });
        // The answer itself may have ended it a moment ago: nothing twice.
        if (ended.isErr() && ended.error.code !== "TRANSITION_DENIED") return err(ended.error);
      }
      const now = await this.d.repo.load(input.runId);
      if (now.isErr()) return err(now.error);
      return ok({ state: "fine", by: fine.answer.by, run: now.value.state.status });
    }
    const asked = await this.d.journal.ask(input.runId, {
      stage: run.value.state.stage,
      source: "agent",
      agent: QUICK_ASKER,
      prompt: QUICK_READY_PROMPT,
      options: [
        { label: QUICK_OPTIONS.openDiff, description: "Look at what changed; nothing is committed" },
        { label: QUICK_OPTIONS.fine, description: "The change stays in the working tree; the run ends" },
      ],
      multiSelect: false,
    });
    if (asked.isErr()) return err(asked.error);
    return ok({ state: "waiting", question: asked.value.id });
  }
}

/**
 * `metator quick reviewed`, the gate of the review stage: reads the reviewer's `quick-review.md`.
 * A blocking finding fails the gate (the run goes back to build once, with the findings); a file
 * that is no review fails it too. Decided from the file, on every host and in a drive alike.
 */
export class QuickReviewed {
  constructor(
    private readonly d: {
      readonly repo: Pick<RunRepository, "runDir">;
      readonly fs: Pick<FileSystem, "read" | "exists">;
    },
  ) {}

  async execute(input: {
    readonly runId: string;
  }): Promise<Result<{ readonly blocking: 0; readonly file: string }, MetatorError>> {
    const file = `${this.d.repo.runDir(input.runId)}/quick-review.md`;
    if (!(await this.d.fs.exists(file)))
      return err(
        new MetatorError("CHECK_FAILED", `no review yet: ${file} is not there`, {
          hint: "The review stage's agent (mt-quick-review) writes it.",
        }),
      );
    const text = await this.d.fs.read(file);
    if (text.isErr()) return err(text.error);
    const findings = quickReviewFindings(text.value);
    if (!findings)
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `${file} is no review: its first line is neither \`No blocking finding.\` nor \`BLOCKING: <n>\``,
        ),
      );
    if (findings.length > 0)
      return err(
        new MetatorError(
          "CHECK_FAILED",
          `the review has ${findings.length} blocking finding(s): ${findings.join("; ")}`,
          { hint: "Fix them in the build stage; the review runs once more.", details: { findings } },
        ),
      );
    return ok({ blocking: 0, file });
  }
}
