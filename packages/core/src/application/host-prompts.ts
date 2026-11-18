import { MetatorError } from "../domain/errors.ts";
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
  readonly type?: (paneId: string, text: string) => Promise<Result<void, MetatorError>>;
  /** The pane's screen as printed: what was typed at a prompt is read back from it. */
  readonly screen?: (paneId: string) => string;
  /** Who holds the keyboard of the run's panes (the driver lock), if a person does. */
  readonly holder?: (runId: string) => Promise<string | undefined>;
  /** The open prompts, kept by the caller so the daemon's check and an answer share them. */
  readonly open?: Map<string, OpenPrompt>;
}

/** One host prompt in the inbox: the question it became, and the screen line it was asked for. */
export interface OpenPrompt {
  readonly runId: string;
  readonly questionId: string;
  /** The blocked line the question was asked for: another line is another question. */
  readonly prompt: string;
  readonly host: string;
  /** A question the agent asks (typed for the person), or the host's own permission prompt. */
  readonly asks: boolean;
  handled: boolean;
}

export interface HostPromptsReport {
  /** Panes whose host prompt was put in the inbox this tick. */
  readonly asked: readonly { readonly paneId: string; readonly runId: string; readonly questionId: string }[];
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
      if (!pane.runId) continue;
      seen.add(pane.paneId);
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
        const q = await this.d.journal.ask(pane.runId, {
          stage: who?.stage ?? "session",
          source: asks ? "agent" : "permission",
          agent: asker,
          prompt: asks ? read.prompt : hostPromptText(asker, pane.paneId, pane.reason),
          options: [
            ...(asks ? read.options.map((label) => ({ label })) : []),
            {
              label: ATTACH_PANE,
              description: "Take the keyboard of the session and answer the host yourself",
            },
            ...(asks
              ? []
              : [{ label: LEAVE_PANE, description: "Leave the prompt as it is; the session waits" }]),
          ],
          multiSelect: false,
        });
        if (q.isErr()) return err(q.error);
        this.open.set(pane.paneId, {
          runId: pane.runId,
          questionId: q.value.id,
          prompt: pane.reason,
          host: pane.host,
          asks,
          handled: false,
        });
        asked.push({ paneId: pane.paneId, runId: pane.runId, questionId: q.value.id });
        if (this.d.notify) await this.d.notify.notify(q.value);
        continue;
      }
      if (item) {
        // The prompt went away: someone answered the host in the pane (or it moved on).
        const closed = await this.close(pane.paneId, item);
        if (closed.isErr()) return err(closed.error);
        resolved.push(pane.paneId);
      }
    }
    for (const paneId of [...this.open.keys()]) if (!seen.has(paneId)) this.open.delete(paneId);
    return ok({ asked, attached, resolved });
  }

  /**
   * Before a card's answer to a pane's question is recorded: when the screen moved on (the
   * question was answered in the pane), the pane's answer is recorded now and the card's then
   * finds the question answered; when a person holds the pane's keyboard, the card is refused
   * (nothing is ever typed over them).
   */
  async settle(runId: string, questionId: string): Promise<Result<void, MetatorError>> {
    const found = this.itemOf(runId, questionId);
    if (!found) return ok(undefined);
    const [paneId, item] = found;
    const panes = await this.d.sensor.all();
    if (panes.isErr()) return err(panes.error);
    const pane = panes.value.find((p) => p.paneId === paneId);
    if (pane?.state !== "blocked" || pane.reason !== item.prompt || this.answeredThere(paneId, item))
      return this.close(paneId, item);
    const holder = item.asks ? await this.d.holder?.(runId) : undefined;
    if (holder)
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
    const questions = await this.d.journal.questions(item.runId);
    if (questions.isErr()) return err(questions.error);
    const q = questions.value.find((x) => x.id === item.questionId);
    if (!q?.answer) return ok(undefined);
    const choice = q.answer.choices[0];
    if (choice === ATTACH_PANE) {
      const lock = await this.d.lock.attach({ runId: item.runId, by: q.answer.by });
      // Already attached (by them or another): the pane shows who; nothing to force.
      if (lock.isOk()) attached.push({ paneId, runId: item.runId, by: q.answer.by });
    } else if (
      q.source === "agent" &&
      this.d.type &&
      choice !== LEAVE_PANE &&
      q.answer.by !== `pane:${paneId}`
    ) {
      // The person's answer to the agent's terminal question: typed into the pane for them.
      const words = choice === "Other" || choice === undefined ? q.answer.text : choice;
      if (words) {
        const typed = await this.d.type(paneId, words);
        if (typed.isErr()) return err(typed.error);
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
      if (answered.isErr()) return err(answered.error);
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
