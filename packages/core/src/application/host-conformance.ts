import {
  firstRunTrust,
  judgeConformance,
  type LabAction,
  type LabQuestion,
  type LabView,
  optionMatching,
  refusalOf,
  tail,
} from "../domain/conformance-lab.ts";
import { MetatorError } from "../domain/errors.ts";
import {
  boundEvidence,
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_CHECKS,
  CONFORMANCE_RUN_PROMPT,
  CONFORMANCE_THREAD_TITLE,
  type ConformanceCheck,
  type ConformanceCheckResult,
  type ConformanceSeen,
  type ConformanceSession,
  type ConformanceStep,
  conformanceFileName,
  conformanceSeen,
  fillConformance,
  type HostConformance,
  HostConformanceDocument,
  renderConformance,
} from "../domain/host-conformance.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, ConformanceLab, ReadonlyFileSystem, Timer } from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";

/** Why the suite does not run where no real AI host may start (the test suites, CI). */
export const CONFORMANCE_REFUSAL =
  "the conformance suite drives a real host; unset METATOR_NO_REAL_HOSTS to run it";

/** Where `metator host conformance` keeps its runs by default, and where `metator doctor` reads them. */
export const CONFORMANCE_DIR = ".metator/conformance";

export interface RunHostConformanceDependencies {
  readonly lab: ConformanceLab;
  readonly clock: Clock;
  readonly timer: Timer;
  /** A fresh lowercase word the session was never shown. */
  readonly nonce: () => string;
  readonly metatorVersion: string;
  /** The hosts that can run in a pane here. */
  readonly hosts: readonly string[];
  /** Why this host may not be driven here (a real host where `METATOR_NO_REAL_HOSTS` is set). */
  readonly refusal: (host: string) => string | undefined;
  /** What the host's CLI says its version is; undefined when it cannot be asked. */
  readonly version: (host: string) => Promise<string | undefined>;
}

export interface RunHostConformanceInput {
  readonly host: string;
  /** Only these checks; the others are recorded as skipped. */
  readonly only?: readonly string[];
  /** How long one check may take (default 180 s). */
  readonly timeoutMs?: number;
  /** How long the session stays idle before its turn counts as over (default 4 s). */
  readonly settleMs?: number;
  /** How often the suite looks (default 1 s). */
  readonly pollMs?: number;
  /** Keep the throwaway repository for a look afterwards. */
  readonly keep?: boolean;
  /** Where the report goes (default `.metator/conformance`). */
  readonly out?: string;
  /** Told a line as the run goes: the repository set up, each check as it ends. */
  readonly progress?: (line: string) => void;
}

export interface HostConformanceRun {
  readonly document: HostConformance;
  readonly files: { readonly json: string; readonly report: string };
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** The repository, when it was kept. */
  readonly kept?: string;
}

/** What one run of the suite knows across its checks. */
interface Suite {
  readonly host: string;
  /** The run's word: the thread's title holds it. */
  readonly word: string;
  /** The repository's directory name: a host may be told to trust that folder only. */
  readonly repoMark: string;
  readonly panes: Partial<Record<ConformanceSession, string>>;
  readonly timeoutMs: number;
  readonly settleMs: number;
  readonly pollMs: number;
}

/** What one check knows while it plays. */
interface Play {
  readonly check: ConformanceCheck;
  readonly vars: { readonly nonce: string; readonly run: string };
  readonly deadline: number;
  readonly notes: string[];
  readonly files: readonly string[];
  readonly judged: {
    readonly since: string;
    commitsBefore: number;
    readonly prompts: string[];
    firstWords?: string;
    lastWords?: string;
  };
  /** Host prompts already answered, by question id. */
  readonly handled: Set<string>;
  /** When the session was last given something to do, and when it was last seen busy since. */
  givenAt?: number | undefined;
  busyAt?: number | undefined;
  idleSince?: number | undefined;
  trustTries: number;
  /** The question a `question` step waits for, then answers. */
  question?: LabQuestion;
  awaiting?: "permission" | "agent" | undefined;
  failed: boolean;
}

/**
 * `metator host conformance` (ADR-0098): the same checks against one host's real CLI, in a fresh
 * repository with a daemon of its own, as a person's sessions. A failed check never stops the
 * suite; the repository and everything running in it go at the end (kept when asked). The result
 * is a `HostConformance` document and its report.
 */
export class RunHostConformance {
  constructor(private readonly d: RunHostConformanceDependencies) {}

  async execute(input: RunHostConformanceInput): Promise<Result<HostConformanceRun, MetatorError>> {
    const d = this.d;
    if (!d.hosts.includes(input.host))
      return err(
        MetatorError.usage(
          `no interactive host ${input.host} here`,
          `The hosts that run in a pane: ${d.hosts.join(", ")}.`,
        ),
      );
    const unknown = (input.only ?? []).filter((id) => !CONFORMANCE_CHECK_IDS.includes(id));
    if (unknown.length > 0)
      return err(
        MetatorError.usage(
          `no such check: ${unknown.join(", ")}`,
          `The checks: ${CONFORMANCE_CHECK_IDS.join(", ")}.`,
        ),
      );
    const refused = d.refusal(input.host);
    if (refused) return err(MetatorError.usage(CONFORMANCE_REFUSAL, refused));

    const startedAt = d.clock.now().toISOString();
    const cliVersion = (await d.version(input.host)) ?? (input.host === "scenario" ? "scenario" : "unknown");
    const say = input.progress ?? (() => undefined);
    say(`${input.host} ${cliVersion}: setting up a throwaway repository and its daemon…`);
    const opened = await d.lab.open({ host: input.host, out: input.out ?? CONFORMANCE_DIR });
    if (opened.isErr()) {
      await d.lab.close(input.keep === true);
      return err(opened.error);
    }
    const suite: Suite = {
      host: input.host,
      word: d.nonce(),
      repoMark: opened.value.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? opened.value.repo,
      panes: {},
      timeoutMs: input.timeoutMs ?? 180_000,
      settleMs: input.settleMs ?? 4_000,
      pollMs: input.pollMs ?? 1_000,
    };
    const checks: ConformanceCheckResult[] = [];
    let closed: Result<{ readonly kept?: string }, MetatorError> = ok({});
    try {
      for (const check of CONFORMANCE_CHECKS) {
        if (input.only && !input.only.includes(check.id)) {
          checks.push({
            id: check.id,
            title: check.title,
            result: "skipped",
            evidence: "not selected (--only)",
            tookMs: 0,
          });
          continue;
        }
        const result = await this.play(check, suite);
        checks.push(result);
        say(
          `${result.result === "pass" ? "✓" : "✗"} ${check.id} (${Math.round(result.tookMs / 1000)} s)${result.result === "pass" ? "" : `: ${result.evidence.split("\n").at(-1) ?? ""}`}`,
        );
      }
    } finally {
      // Nothing of the run outlives it: the daemon, the host, the repository (unless kept).
      closed = await d.lab.close(input.keep === true);
    }
    const document: HostConformance = {
      host: input.host,
      cliVersion,
      os: opened.value.os,
      metatorVersion: d.metatorVersion,
      startedAt,
      endedAt: d.clock.now().toISOString(),
      checks,
    };
    const name = conformanceFileName(input.host, cliVersion);
    const json = await d.lab.save(
      `${name}.json`,
      serializeJsonDocument(HostConformanceDocument.stamp(document)),
    );
    if (json.isErr()) return err(json.error);
    const report = await d.lab.save(`${name}.md`, renderConformance(document));
    if (report.isErr()) return err(report.error);
    const count = (r: ConformanceCheckResult["result"]) => checks.filter((c) => c.result === r).length;
    return ok({
      document,
      files: { json: json.value, report: report.value },
      passed: count("pass"),
      failed: count("fail"),
      skipped: count("skipped"),
      ...(closed.isOk() && closed.value.kept ? { kept: closed.value.kept } : {}),
    });
  }

  /** One check, start to end: a step that cannot be done ends it; every expectation is judged. */
  private async play(check: ConformanceCheck, suite: Suite): Promise<ConformanceCheckResult> {
    const started = this.d.clock.now();
    const play: Play = {
      check,
      vars: { nonce: this.d.nonce(), run: suite.word },
      deadline: started.getTime() + suite.timeoutMs,
      notes: [],
      files: check.steps.flatMap((s) => ("expect" in s && "file" in s.expect ? [s.expect.file.path] : [])),
      judged: { since: started.toISOString(), commitsBefore: 0, prompts: [] },
      handled: new Set(),
      trustTries: 0,
      failed: false,
    };
    try {
      // A check that does not open its session works in the one there is (opened when missing),
      // once that session is at rest.
      if (!check.steps.some((s) => "open" in s)) {
        await this.session(check.session, suite, play);
        await this.rest(suite, play);
      }
      const first = await this.look(suite, play);
      play.judged.commitsBefore = first.git.commits;
      for (const step of check.steps) await this.step(step, suite, play);
    } catch (e) {
      // A step that cannot be done ends its check, failed, with why; the suite goes on.
      play.failed = true;
      play.notes.push(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      id: check.id,
      title: check.title,
      result: play.failed ? "fail" : "pass",
      evidence: boundEvidence(play.notes.join("\n")),
      tookMs: Math.max(0, this.d.clock.now().getTime() - started.getTime()),
    };
  }

  private async step(step: ConformanceStep, suite: Suite, play: Play): Promise<void> {
    const fill = (text: string) => fillConformance(text, play.vars);
    const pane = () => suite.panes[play.check.session] as string;
    if ("open" in step) return this.open(step.open, suite, play);
    if ("rest" in step) return this.rest(suite, play);
    if ("working" in step) {
      const seen = await this.until("the session to work", suite, play, (v) => v.pane?.state === "working");
      play.notes.push(`working: ${seen.pane?.reason ?? "output"}`);
      return;
    }
    if ("say" in step || "tell" in step || "interrupt" in step) {
      const [kind, raw] =
        "say" in step
          ? (["type", step.say] as const)
          : "tell" in step
            ? (["tell", step.tell] as const)
            : (["interrupt", step.interrupt] as const);
      const text = fill(raw);
      const action: LabAction =
        kind === "type" ? { kind, pane: pane(), text, enter: true } : { kind, pane: pane(), text };
      await this.act(action, `could not ${kind === "type" ? "type into" : kind} the session`);
      play.judged.firstWords ??= text;
      play.judged.lastWords = text;
      play.givenAt = this.d.clock.now().getTime();
      play.notes.push(`${kind === "type" ? "said" : kind === "tell" ? "told" : "interrupted"}: ${text}`);
      return;
    }
    if ("write" in step) {
      await this.act(
        { kind: "write", path: step.write.path, text: fill(step.write.text), stage: step.write.stage },
        `could not write ${step.write.path}`,
      );
      return;
    }
    if ("restart" in step) return this.restart(suite, play);
    if ("question" in step) {
      const want = step.question;
      play.awaiting = want.source;
      const matches = want.matches ? fill(want.matches).toLowerCase() : undefined;
      const fits = (q: LabQuestion): boolean =>
        q.source === want.source &&
        (matches === undefined || `${q.prompt}\n${q.command ?? ""}`.toLowerCase().includes(matches)) &&
        (want.options ?? []).every((o) => q.options.some((label) => label.toLowerCase().includes(o)));
      const seen = await this.until(`a ${want.source} question in the inbox`, suite, play, (v) =>
        v.questions.some(fits),
      );
      play.question = seen.questions.find(fits) as LabQuestion;
      play.awaiting = undefined;
      const q = play.question;
      play.notes.push(
        `question ${q.id} (${q.source}): ${q.prompt}${q.command ? `\n  command: ${q.command}` : ""}${q.reason ? `\n  reason: ${q.reason}` : ""}\n  options: ${q.options.join(" | ")}`,
      );
      return;
    }
    if ("answer" in step) {
      const q = play.question;
      if (!q) throw new MetatorError("CHECK_FAILED", "no question to answer");
      const choice = optionMatching(q, step.answer);
      if (!choice)
        throw new MetatorError(
          "CHECK_FAILED",
          `question ${q.id} has no option like /${step.answer}/: ${q.options.join(" | ")}`,
        );
      await this.act({ kind: "answer", pane: pane(), question: q.id, choice }, `could not answer ${q.id}`);
      play.handled.add(q.id);
      play.givenAt = this.d.clock.now().getTime();
      play.notes.push(`answered in the inbox: ${choice}`);
      return;
    }
    const expected = fillExpectation(step.expect, play.vars);
    const seen = await this.look(suite, play);
    const verdict = judgeConformance(expected, seen, play.judged);
    play.notes.push(`${verdict.ok ? "ok" : "FAIL"}: ${verdict.evidence}`);
    if (!verdict.ok) play.failed = true;
  }

  /** The session the check works in: there and alive (or paused), else opened. */
  private async session(session: ConformanceSession, suite: Suite, play: Play): Promise<void> {
    const pane = suite.panes[session];
    if (pane) {
      const seen = await this.look(suite, play, pane);
      if (seen.pane?.alive || seen.pane?.paused) return;
      play.notes.push(`the ${session} session in pane ${pane} had ended: a new one was opened`);
    }
    await this.open(session, suite, play);
    await this.rest(suite, play);
  }

  private async open(session: ConformanceSession, suite: Suite, play: Play): Promise<void> {
    const opened = await this.act(
      session === "chat"
        ? { kind: "session", session, title: fillConformance(CONFORMANCE_THREAD_TITLE, play.vars) }
        : { kind: "session", session, prompt: CONFORMANCE_RUN_PROMPT },
      `could not open the ${session} session`,
    );
    if (!opened.pane) throw new MetatorError("CHECK_FAILED", `the ${session} session opened no pane`);
    suite.panes[session] = opened.pane;
    play.givenAt = this.d.clock.now().getTime();
    play.notes.push(`opened the ${session} session in pane ${opened.pane}`);
  }

  /**
   * Until the session's turn is over: idle at its prompt with no approval open, for `settleMs`
   * without a break, and busy at some point since it was last given something (or given long ago).
   */
  private async rest(suite: Suite, play: Play): Promise<void> {
    play.idleSince = undefined;
    await this.until("the session to come to rest", suite, play, (v) => {
      const now = this.d.clock.now().getTime();
      const open = v.questions.some((q) => q.source === "permission");
      if (v.pane?.state !== "idle" || open) {
        play.idleSince = undefined;
        return false;
      }
      play.idleSince ??= now;
      const moved =
        play.givenAt === undefined ||
        (play.busyAt !== undefined && play.busyAt >= play.givenAt) ||
        now - play.givenAt >= 3 * suite.settleMs;
      return moved && now - play.idleSince >= suite.settleMs;
    });
  }

  /** The daemon killed and started again: the pane paused, continued, the same session. */
  private async restart(suite: Suite, play: Play): Promise<void> {
    const before = (await this.look(suite, play)).pane?.sessionId;
    await this.act({ kind: "restart" }, "could not kill and start the daemon again");
    const paused = await this.until(
      "the pane to be paused",
      suite,
      play,
      (v) => v.pane?.paused !== undefined,
    );
    play.notes.push(`daemon killed (SIGKILL) and started again: pane paused (${paused.pane?.paused})`);
    const pane = suite.panes[play.check.session] as string;
    await this.act({ kind: "continue", pane }, `could not continue pane ${pane}`);
    play.givenAt = this.d.clock.now().getTime();
    const back = await this.until(
      "the pane to run again",
      suite,
      play,
      (v) => v.pane?.alive === true && v.pane.paused === undefined,
    );
    const after = back.pane?.sessionId;
    if (!before || after !== before)
      throw new MetatorError(
        "CHECK_FAILED",
        `the pane came back as session ${after ?? "(none)"}, not ${before ?? "(none)"}`,
      );
    play.notes.push(`continued: session ${after} resumed in pane ${pane}`);
  }

  /** Looks until `probe` holds; meanwhile the host's own prompts no step waits for are answered. */
  private async until(
    what: string,
    suite: Suite,
    play: Play,
    probe: (seen: LabView) => boolean,
  ): Promise<LabView> {
    for (;;) {
      const seen = await this.look(suite, play);
      if (seen.pane?.state && seen.pane.state !== "idle") play.busyAt = this.d.clock.now().getTime();
      if (await this.attend(seen, suite, play)) continue;
      if (probe(seen)) return seen;
      if (seen.pane && !seen.pane.alive && seen.pane.paused === undefined)
        throw new MetatorError(
          "CHECK_FAILED",
          `the session exited while waiting for ${what}; its last lines:\n${tail(seen.screen, 12)}`,
        );
      if (this.d.clock.now().getTime() > play.deadline)
        throw new MetatorError(
          "CHECK_FAILED",
          `timed out after ${Math.round(suite.timeoutMs / 1000)} s waiting for ${what} (pane: ${seen.pane?.state ?? "?"}${seen.pane?.reason ? `, ${seen.pane.reason}` : ""}); its last lines:\n${tail(seen.screen, 12)}`,
        );
      await this.d.timer.sleep(suite.pollMs);
    }
  }

  /**
   * The host's own prompts while a check waits: its first-run question to trust the suite's own
   * repository is answered Yes; any approval no step waits for is answered No (and noted: a check
   * that expects none fails). True when something was answered.
   */
  private async attend(seen: LabView, suite: Suite, play: Play): Promise<boolean> {
    const pane = suite.panes[play.check.session];
    if (!pane) return false;
    const trust = play.trustTries < 3 ? firstRunTrust(seen, suite.repoMark) : undefined;
    if (trust) {
      play.trustTries++;
      if ("question" in trust) {
        play.handled.add(trust.question.id);
        await this.act(
          { kind: "answer", pane, question: trust.question.id, choice: trust.choice },
          "could not answer the host's first-run question",
        );
      } else
        await this.act(
          { kind: "type", pane, text: trust.key, enter: true },
          "could not answer the host's first-run question",
        );
      play.notes.push(`first run: ${suite.host} asked to trust the throwaway repository; answered Yes`);
      await this.d.timer.sleep(suite.pollMs);
      return true;
    }
    let answered = false;
    for (const q of seen.questions) {
      if (q.source !== "permission" || play.handled.has(q.id) || play.awaiting === "permission") continue;
      play.handled.add(q.id);
      const asked = q.command ?? q.prompt;
      play.judged.prompts.push(asked);
      const no = refusalOf(q);
      if (!no) {
        play.notes.push(`the host asked (${asked}) with no No to answer: ${q.options.join(" | ")}`);
        continue;
      }
      await this.act({ kind: "answer", pane, question: q.id, choice: no }, `could not answer ${q.id}`);
      play.notes.push(`the host asked: ${asked}; answered ${no}`);
      answered = true;
    }
    return answered;
  }

  private async look(suite: Suite, play: Play, pane = suite.panes[play.check.session]): Promise<LabView> {
    const seen = await this.d.lab.look({
      ...(pane ? { pane } : {}),
      files: play.files.map((f) => fillConformance(f, play.vars)),
    });
    if (seen.isErr()) throw new MetatorError("CHECK_FAILED", `could not look: ${seen.error.message}`);
    return seen.value;
  }

  private async act(action: LabAction, what: string): Promise<{ readonly pane?: string }> {
    const done = await this.d.lab.act(action);
    if (done.isErr()) throw new MetatorError("CHECK_FAILED", `${what}: ${done.error.message}`);
    return done.value;
  }
}

/** An expectation with the check's words filled in. */
function fillExpectation(
  e: Extract<ConformanceStep, { expect: unknown }>["expect"],
  vars: Play["vars"],
): typeof e {
  const f = (t: string) => fillConformance(t, vars);
  if ("screen" in e) return { screen: f(e.screen) };
  if ("absent" in e) return { absent: f(e.absent) };
  if ("guard" in e) return { guard: { decision: e.guard.decision, reason: f(e.guard.reason) } };
  if ("file" in e) return { file: { path: f(e.file.path), contains: f(e.file.contains) } };
  if ("commits" in e) return { commits: e.commits, ...(e.subject ? { subject: f(e.subject) } : {}) };
  return e;
}

/** A kept run of the suite, read and checked (`metator host conformance diff`). */
export function readConformance(text: string, source: string): Result<HostConformance, MetatorError> {
  return parseDocumentText(text, source, HostConformanceDocument, "json");
}

/**
 * The runs of the suite kept in the repository (`.metator/conformance/*.json`) for
 * `metator doctor`: the last passing one per host, with the version installed here now.
 */
export class ConformanceHistory {
  constructor(
    private readonly fs: Pick<ReadonlyFileSystem, "glob" | "read">,
    private readonly version: (host: string) => Promise<string | undefined>,
    private readonly dir: string = CONFORMANCE_DIR,
  ) {}

  async seen(): Promise<readonly ConformanceSeen[]> {
    const docs: HostConformance[] = [];
    for (const file of await this.fs.glob([`${this.dir}/*.json`])) {
      const text = await this.fs.read(file);
      const doc = text.isOk() ? readConformance(text.value, file) : undefined;
      if (doc?.isOk()) docs.push(doc.value);
    }
    const seen: ConformanceSeen[] = [];
    for (const s of conformanceSeen(docs)) {
      const installed = await this.version(s.host);
      seen.push(installed ? { ...s, installed } : s);
    }
    return seen;
  }
}
