import { agentQuestionOf } from "../domain/agent-question.ts";
import { MetatorError } from "../domain/errors.ts";
import type { MenuChoice } from "../domain/host-manifest.ts";
import {
  ANSWERED_IN_PANE,
  ATTACH_PANE,
  answerAfter,
  hostPromptText,
  LEAVE_PANE,
  terminalQuestionOf,
} from "../domain/host-manifest.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { DriverLock } from "./driver-lock.ts";
import type { Notifier } from "./notifier.ts";
import type { PaneQuestion, PaneQuestions } from "./pane-questions.ts";
import type { PaneIdentity, PaneSensor } from "./pane-sensor.ts";
import type { RunJournal } from "./run-journal.ts";

export interface HostPromptsDependencies {
  readonly sensor: Pick<PaneSensor, "all">;
  readonly journal: Pick<RunJournal, "questions" | "ask" | "answer" | "record">;
  readonly lock: Pick<DriverLock, "attach">;
  readonly notify?: Pick<Notifier, "notify">;
  /** Who a pane is in its run: its prompt is that agent's question, at its stage. */
  readonly identity?: PaneIdentity;
  /** Types a person's answer to a terminal question into its pane (never over a person). */
  readonly type?: (paneId: string, text: string, by?: string) => Promise<Result<void, MetatorError>>;
  /** The pane's screen as printed: what was typed at a prompt is read back from it. */
  readonly screen?: (paneId: string) => string;
  /** Who holds the keyboard of the run's panes (the driver lock), if a person does. */
  readonly holder?: (runId: string) => Promise<string | undefined>;
  /** The open prompts, kept by the caller so the daemon's check and an answer share them. */
  readonly open?: Map<string, OpenPrompt>;
  /** Where a pane without a run asks (the intake chat): without it, such a pane asks nothing. */
  readonly panes?: PaneQuestions;
  /** A pane's screen as rendered: an agent's question in words is read from its last message. */
  readonly rendered?: (paneId: string) => Promise<string | undefined>;
  /**
   * Why MetatorAI's guard asked about (or refused) this command in this pane lately, if it did: a
   * host does not always show a hook's reason in its prompt, so the card says it.
   */
  readonly guardReason?: (paneId: string, command: string) => Promise<string | undefined>;
}

/** The roles whose panes run an agent that may ask the person in words (not shells, not gates). */
const AGENT_ROLES: ReadonlySet<string> = new Set(["conductor", "worker", "apps"]);

/** One host prompt in the inbox: the question it became, and the screen line it was asked for. */
export interface OpenPrompt {
  /** The run whose question it became; none for a pane without a run (a pane question). */
  readonly runId?: string;
  readonly questionId: string;
  /** The blocked line the question was asked for: another line is another question. */
  readonly prompt: string;
  readonly host: string;
  /** A question the agent asks (typed for the person), or the host's own permission prompt. */
  readonly asks: boolean;
  /** The host's numbered choices: a person's choice is typed as its key. */
  readonly menu?: readonly MenuChoice[];
  /**
   * An agent's question in words (its last message asks): it lives with the pane's questions even
   * in a run's pane, and a choice is typed as its reply (a number, a reply word).
   */
  readonly said?: { readonly replies: Readonly<Record<string, string>> };
  handled: boolean;
}

export interface HostPromptsReport {
  /** Panes whose host prompt was put in the inbox this tick (no run: a pane question). */
  readonly asked: readonly {
    readonly paneId: string;
    readonly runId?: string;
    readonly questionId: string;
  }[];
  /** People attached to a run because they chose to answer in the pane. */
  readonly attached: readonly { readonly paneId: string; readonly runId: string; readonly by: string }[];
  /** Host prompts that went away (answered in the pane); their inbox item closed. */
  readonly resolved: readonly string[];
}

/**
 * Host prompts in the inbox (R3, ADR-0080): when a run's pane is `blocked` (the host's own
 * permission prompt on the screen), the question reaches the person as a MetatorAI question with
 * two choices: attach and answer in the pane, or leave it. Only a person answers a host's prompt,
 * so nothing is typed for them; the choice to attach takes the driver lock under their name.
 * When the screen moves on, the inbox item is closed as answered in the pane.
 */
/** The choice for words of the person's own. */
const OTHER_CHOICE = "Other";

/** A question kept with the pane's own (a pane without a run, or an agent's question in words). */
const inPane = (item: OpenPrompt): boolean => !item.runId || item.said !== undefined;

export class HostPrompts {
  /** The inbox item per blocked pane; `handled` once the person answered it (attached or left it). */
  private readonly open: Map<string, OpenPrompt>;

  constructor(private readonly d: HostPromptsDependencies) {
    this.open = d.open ?? new Map();
  }

  async tick(): Promise<Result<HostPromptsReport, MetatorError>> {
    const panes = await this.d.sensor.all();
    if (panes.isErr()) return err(panes.error);
    const asked: HostPromptsReport["asked"][number][] = [];
    const attached: HostPromptsReport["attached"][number][] = [];
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const pane of panes.value) {
      // A pane without a run asks too (the intake chat): its question is the pane's own.
      if (!pane.runId && !this.d.panes) continue;
      seen.add(pane.paneId);
      const said = await this.saidInWords(pane, asked);
      if (said.isErr()) return err(said.error);
      if (said.value === "asking") continue;
      if (said.value === "closed") resolved.push(pane.paneId);
      let item = this.open.get(pane.paneId);
      // Another question on the screen, or words typed after this one: it was answered there;
      // each question gets its own card.
      if (
        item &&
        pane.state === "blocked" &&
        (pane.reason !== item.prompt || this.answeredThere(pane.paneId, item))
      ) {
        const closed = await this.close(pane.paneId, item);
        if (closed.isErr()) return err(closed.error);
        resolved.push(pane.paneId);
        item = undefined;
      }
      if (pane.state === "blocked") {
        if (item) {
          if (!item.handled) {
            const done = await this.followUp(pane.paneId, item, attached);
            if (done.isErr()) return err(done.error);
          }
          continue;
        }
        // The agent in the pane asks (a worker by its name, the conductor by its agent), at its stage.
        const who = await this.d.identity?.of(pane.paneId);
        const asker = who?.agent ?? pane.host;
        // A question the agent asks in its terminal (its words, its options) is the agent's
        // question; the host's own prompt for leave to use a tool is a permission.
        const read = terminalQuestionOf(pane.reason);
        const asks = read.kind === "question" && this.d.type !== undefined;
        // Its line is still on the screen, but words were typed after it: answered, not asked anew.
        if (asks && answerAfter(this.d.screen?.(pane.paneId) ?? "", pane.reason) !== undefined) continue;
        // A host's numbered menu (Claude Code's approval): its choices are the card's, its prompt
        // the readable line the sensor gave; a choice is typed as its key.
        const menu = !asks && pane.menu && pane.menu.length > 0 && this.d.type ? pane.menu : undefined;
        // The host asks because the guard did: the guard's reason, which the host's prompt leaves out.
        const reason =
          !asks && pane.command ? await this.d.guardReason?.(pane.paneId, pane.command) : undefined;
        const question = {
          source: asks ? ("agent" as const) : ("permission" as const),
          agent: asker,
          prompt: asks ? read.prompt : menu ? pane.reason : hostPromptText(asker, pane.paneId, pane.reason),
          ...(!asks && pane.command ? { command: pane.command } : {}),
          ...(reason ? { reason } : {}),
          options: [
            ...(asks ? read.options.map((label) => ({ label })) : []),
            ...(menu ?? []).map((c) => ({ label: c.label })),
            {
              label: ATTACH_PANE,
              description: "Take the keyboard of the session and answer the host yourself",
            },
            ...(asks
              ? []
              : [{ label: LEAVE_PANE, description: "Leave the prompt as it is; the session waits" }]),
          ],
        };
        let questionId: string;
        if (pane.runId) {
          const q = await this.d.journal.ask(pane.runId, {
            ...question,
            stage: who?.stage ?? "session",
            multiSelect: false,
          });
          if (q.isErr()) return err(q.error);
          questionId = q.value.id;
          if (this.d.notify) await this.d.notify.notify(q.value);
        } else {
          const q = (this.d.panes as PaneQuestions).ask({
            ...question,
            paneId: pane.paneId,
            host: pane.host,
            // Words of the agent's own may answer it, as at a run's question.
            options: asks
              ? [...question.options, { label: OTHER_CHOICE, description: "Answer in your own words" }]
              : question.options,
          });
          questionId = q.id;
        }
        this.open.set(pane.paneId, {
          ...(pane.runId ? { runId: pane.runId } : {}),
          questionId,
          prompt: pane.reason,
          host: pane.host,
          asks,
          ...(menu ? { menu } : {}),
          handled: false,
        });
        asked.push({ paneId: pane.paneId, ...(pane.runId ? { runId: pane.runId } : {}), questionId });
        continue;
      }
      if (item) {
        // The prompt went away: someone answered the host in the pane (or it moved on).
        const closed = await this.close(pane.paneId, item);
        if (closed.isErr()) return err(closed.error);
        resolved.push(pane.paneId);
      }
    }
    for (const [paneId, item] of [...this.open]) {
      if (seen.has(paneId)) continue;
      this.open.delete(paneId);
      // A pane that is gone (closed) asks nothing any more: its question leaves the inbox.
      if (inPane(item)) this.d.panes?.forget(paneId);
    }
    return ok({ asked, attached, resolved });
  }

  /**
   * Before a card's answer to a pane's question is recorded: when the screen moved on (the
   * question was answered in the pane), the pane's answer is recorded now and the card's then
   * finds the question answered; when another person holds the run's keyboard, the card is
   * refused (nothing is ever typed over them). The holder answering on the card is no conflict.
   */
  async settle(runId: string, questionId: string, by?: string): Promise<Result<void, MetatorError>> {
    const found = this.itemOf(runId, questionId);
    if (!found) return ok(undefined);
    const [paneId, item] = found;
    const panes = await this.d.sensor.all();
    if (panes.isErr()) return err(panes.error);
    const pane = panes.value.find((p) => p.paneId === paneId);
    if (pane?.state !== "blocked" || pane.reason !== item.prompt || this.answeredThere(paneId, item))
      return this.close(paneId, item);
    const holder = item.asks ? await this.d.holder?.(runId) : undefined;
    if (holder && holder !== by)
      return err(
        new MetatorError(
          "CONFLICT",
          `${holder} is answering in pane ${paneId}: answer there, or wait until they release it`,
        ),
      );
    return ok(undefined);
  }

  /** Right after a card's answer is recorded: typed into its pane at once, not on the next check. */
  async deliver(runId: string, questionId: string): Promise<Result<void, MetatorError>> {
    const found = this.itemOf(runId, questionId);
    if (!found || found[1].handled) return ok(undefined);
    return this.followUp(found[0], found[1], []);
  }

  /** Words were typed after the agent's question (the terminal echoes them): it was answered there. */
  private answeredThere(paneId: string, item: OpenPrompt): boolean {
    return item.asks && answerAfter(this.d.screen?.(paneId) ?? "", item.prompt) !== undefined;
  }

  /**
   * An agent that ended its turn asking the person in words (its last message asks; it waits
   * idle at its prompt, with no host prompt and no card): a pane question with the whole message
   * and its choices, for a run's pane too. It closes when the agent works again (it was answered
   * in the pane, or by the card's words typed into it) or asks something else.
   */
  private async saidInWords(
    pane: {
      readonly paneId: string;
      readonly runId?: string;
      readonly role: string;
      readonly host: string;
      readonly state: string;
    },
    asked: HostPromptsReport["asked"][number][],
  ): Promise<Result<"asking" | "closed" | "none", MetatorError>> {
    const item = this.open.get(pane.paneId);
    if (!this.d.panes || !this.d.rendered || !AGENT_ROLES.has(pane.role)) return ok("none");
    const read =
      pane.state === "idle" ? agentQuestionOf((await this.d.rendered(pane.paneId)) ?? "") : undefined;
    if (item?.said) {
      if (read && read.text === item.prompt) {
        if (!item.handled) {
          const done = await this.followUp(pane.paneId, item, []);
          if (done.isErr()) return err(done.error);
        }
        return ok("asking");
      }
      // The agent works again, or asks something else: the question was answered.
      const closed = await this.close(pane.paneId, item);
      if (closed.isErr()) return err(closed.error);
      if (!read) return ok("closed");
    } else if (item) return ok("none");
    if (!read) return ok("none");
    // The same message again (answered, or left): not asked twice.
    if (this.d.panes.latest(pane.paneId)?.text === read.text) return ok("none");
    const who = await this.d.identity?.of(pane.paneId);
    const q = this.d.panes.ask({
      paneId: pane.paneId,
      ...(pane.runId ? { runId: pane.runId } : {}),
      source: "agent",
      agent: who?.agent ?? pane.host,
      host: pane.host,
      prompt: read.prompt,
      text: read.text,
      options: [
        ...read.options.map((o) => ({ label: o.label })),
        { label: OTHER_CHOICE, description: "Answer in your own words" },
        { label: LEAVE_PANE, description: "Leave it; the agent waits" },
      ],
    });
    this.open.set(pane.paneId, {
      ...(pane.runId ? { runId: pane.runId } : {}),
      questionId: q.id,
      prompt: read.text,
      host: pane.host,
      asks: true,
      said: { replies: Object.fromEntries(read.options.map((o) => [o.label, o.reply])) },
      handled: false,
    });
    asked.push({ paneId: pane.paneId, ...(pane.runId ? { runId: pane.runId } : {}), questionId: q.id });
    return ok("asking");
  }

  /** A question in words waits in this pane for the person: nothing else is typed into it meanwhile. */
  asksInPane(paneId: string): boolean {
    const item = this.open.get(paneId);
    return item?.said !== undefined && !item.handled;
  }

  /**
   * A person's answer to a pane question (a pane without a run), from the app: checked as the
   * pane shows it now (the prompt gone, or answered there, closes it first: the pane answered),
   * recorded, then typed into the pane at once (a menu's key, the agent's words) unless it is
   * Attach (go to the pane) or Leave it.
   */
  async answerPane(input: {
    readonly paneId: string;
    readonly question: string;
    readonly choices: readonly string[];
    readonly text?: string;
    readonly by: string;
  }): Promise<Result<PaneQuestion, MetatorError>> {
    const questions = this.d.panes;
    if (!questions?.get(input.paneId, input.question))
      return err(MetatorError.notFound(`question ${input.question} of pane ${input.paneId}`));
    const item = this.open.get(input.paneId);
    if (item && inPane(item) && item.questionId === input.question) {
      const panes = await this.d.sensor.all();
      if (panes.isErr()) return err(panes.error);
      const pane = panes.value.find((p) => p.paneId === input.paneId);
      const gone = item.said
        ? pane?.state !== "idle"
        : pane?.state !== "blocked" || pane.reason !== item.prompt || this.answeredThere(input.paneId, item);
      if (gone) {
        const closed = await this.close(input.paneId, item);
        if (closed.isErr()) return err(closed.error);
      }
    }
    const answered = questions.answer(input.paneId, input.question, {
      choices: input.choices,
      ...(input.text ? { text: input.text } : {}),
      by: input.by,
    });
    if (answered.isErr()) return err(answered.error);
    const open = this.open.get(input.paneId);
    if (open && inPane(open) && open.questionId === input.question && !open.handled) {
      const done = await this.followUp(input.paneId, open, []);
      if (done.isErr()) return err(done.error);
    }
    return ok(answered.value);
  }

  /** The question an open prompt became: the run's, or the pane's own. */
  private async questionOf(
    paneId: string,
    item: OpenPrompt,
  ): Promise<Result<Pick<PaneQuestion, "id" | "source" | "answer"> | undefined, MetatorError>> {
    if (!item.runId || item.said) return ok(this.d.panes?.get(paneId, item.questionId));
    const questions = await this.d.journal.questions(item.runId);
    if (questions.isErr()) return err(questions.error);
    const q = questions.value.find((x) => x.id === item.questionId);
    return ok(
      q
        ? {
            id: q.id,
            source: q.source === "gate" ? "permission" : q.source,
            ...(q.answer ? { answer: q.answer } : {}),
          }
        : undefined,
    );
  }

  private itemOf(runId: string, questionId: string): [string, OpenPrompt] | undefined {
    for (const entry of this.open)
      if (entry[1].runId === runId && entry[1].questionId === questionId) return entry;
    return undefined;
  }

  /**
   * A person's answer to an open host prompt: attach them (the driver lock under their name),
   * or note that they leave it. The item stays until the prompt goes away, so it is asked once.
   */
  private async followUp(
    paneId: string,
    item: OpenPrompt,
    attached: HostPromptsReport["attached"][number][],
  ): Promise<Result<void, MetatorError>> {
    const found = await this.questionOf(paneId, item);
    if (found.isErr()) return err(found.error);
    const q = found.value;
    if (!q?.answer) return ok(undefined);
    const choice = q.answer.choices[0];
    const key =
      item.menu?.find((c) => c.label === choice)?.key ?? (choice ? item.said?.replies[choice] : undefined);
    if (choice === ATTACH_PANE) {
      // A pane without a run has no lock to take: the person goes to the pane and types there.
      const lock = item.runId ? await this.d.lock.attach({ runId: item.runId, by: q.answer.by }) : undefined;
      // Already attached (by them or another): the pane shows who; nothing to force.
      if (item.runId && lock?.isOk()) attached.push({ paneId, runId: item.runId, by: q.answer.by });
    } else if (
      (key !== undefined || q.source === "agent") &&
      this.d.type &&
      choice !== LEAVE_PANE &&
      q.answer.by !== `pane:${paneId}`
    ) {
      // The person's answer: a menu's choice by its key, the agent's question by its words.
      const words = key ?? (choice === "Other" || choice === undefined ? q.answer.text : choice);
      if (words) {
        // The run's keyboard held by the one who answered: their own keystrokes; else typed for them.
        const holder = item.runId ? await this.d.holder?.(item.runId) : undefined;
        const typed = await this.d.type(paneId, words, holder === q.answer.by ? holder : undefined);
        if (typed.isErr() && item.runId) {
          // Not typed (someone else took the keyboard meanwhile): said in the activity, never forced.
          const noted = await this.d.journal.record(item.runId, {
            type: "agent",
            origin: "pty",
            agent: item.host,
            text: `the answer to ${q.id} was not typed into pane ${paneId}: ${typed.error.message}`,
          });
          if (noted.isErr()) return err(noted.error);
        }
      }
    }
    item.handled = true;
    return ok(undefined);
  }

  /**
   * The prompt went away (or another took its place): an unanswered question is answered by the
   * pane, as a card answer would be: the words typed after the prompt (an option's label when they
   * name one), by the person at the pane's keyboard, else by the pane.
   */
  private async close(paneId: string, item: OpenPrompt): Promise<Result<void, MetatorError>> {
    this.open.delete(paneId);
    if (!item.runId || item.said) {
      // A pane question: answered by the pane, the words typed after the prompt when it shows them.
      const typed = item.asks ? answerAfter(this.d.screen?.(paneId) ?? "", item.prompt) : undefined;
      const q = this.d.panes?.get(paneId, item.questionId);
      const option = typed
        ? q?.options.find((o) => o.label.toLowerCase() === typed.toLowerCase())?.label
        : undefined;
      this.d.panes?.answeredInPane(
        paneId,
        item.questionId,
        option ? "" : (typed ?? ANSWERED_IN_PANE),
        option ? [option] : typed ? [OTHER_CHOICE] : [],
      );
      return ok(undefined);
    }
    const questions = await this.d.journal.questions(item.runId);
    if (questions.isErr()) return err(questions.error);
    const q = questions.value.find((x) => x.id === item.questionId);
    if (q && !q.answer) {
      const typed = item.asks ? answerAfter(this.d.screen?.(paneId) ?? "", item.prompt) : undefined;
      const option = typed
        ? q.options.find((o) => o.label.toLowerCase() === typed.toLowerCase())?.label
        : undefined;
      const by = (item.asks ? await this.d.holder?.(item.runId) : undefined) ?? `pane:${paneId}`;
      // Not one of the choices and nothing read back: the pane says, in words, that the prompt is gone.
      const answered = await this.d.journal.answer(item.runId, item.questionId, {
        ...(option
          ? { choices: [option] }
          : typed
            ? { choices: ["Other"], text: typed }
            : { choices: [], text: ANSWERED_IN_PANE }),
        by,
      });
      // Another look got there first (the daemon's check and a typed line at once): one answer.
      if (answered.isErr()) {
        const now = await this.d.journal.questions(item.runId);
        if (!(now.isOk() && now.value.find((x) => x.id === item.questionId)?.answer))
          return err(answered.error);
      }
    }
    const noted = await this.d.journal.record(item.runId, {
      type: "agent",
      origin: "pty",
      agent: item.host,
      text: `the host prompt in pane ${paneId} went away`,
    });
    return noted.isErr() ? err(noted.error) : ok(undefined);
  }
}
