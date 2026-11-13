import type { MetatorError } from "../domain/errors.ts";
import { ANSWERED_IN_PANE, ATTACH_PANE, hostPromptText, LEAVE_PANE } from "../domain/host-manifest.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { DriverLock } from "./driver-lock.ts";
import type { Notifier } from "./notifier.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { RunJournal } from "./run-journal.ts";

export interface HostPromptsDependencies {
  readonly sensor: Pick<PaneSensor, "all">;
  readonly journal: Pick<RunJournal, "questions" | "ask" | "answer" | "record">;
  readonly lock: Pick<DriverLock, "attach">;
  readonly notify?: Pick<Notifier, "notify">;
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
  private readonly open = new Map<string, { runId: string; questionId: string; handled: boolean }>();

  constructor(private readonly d: HostPromptsDependencies) {}

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
      const item = this.open.get(pane.paneId);
      if (pane.state === "blocked") {
        if (item) {
          if (!item.handled) {
            const done = await this.followUp(pane.paneId, item, attached);
            if (done.isErr()) return err(done.error);
          }
          continue;
        }
        const q = await this.d.journal.ask(pane.runId, {
          stage: "session",
          source: "permission",
          agent: pane.host,
          prompt: hostPromptText(pane.host, pane.paneId, pane.reason),
          options: [
            {
              label: ATTACH_PANE,
              description: "Take the keyboard of the session and answer the host yourself",
            },
            { label: LEAVE_PANE, description: "Leave the prompt as it is; the session waits" },
          ],
          multiSelect: false,
        });
        if (q.isErr()) return err(q.error);
        this.open.set(pane.paneId, { runId: pane.runId, questionId: q.value.id, handled: false });
        asked.push({ paneId: pane.paneId, runId: pane.runId, questionId: q.value.id });
        if (this.d.notify) await this.d.notify.notify(q.value);
        continue;
      }
      if (item) {
        // The prompt went away: someone answered the host in the pane (or it moved on).
        const closed = await this.close(pane.paneId, item, pane.host);
        if (closed.isErr()) return err(closed.error);
        resolved.push(pane.paneId);
      }
    }
    for (const paneId of [...this.open.keys()]) if (!seen.has(paneId)) this.open.delete(paneId);
    return ok({ asked, attached, resolved });
  }

  /**
   * A person's answer to an open host prompt: attach them (the driver lock under their name),
   * or note that they leave it. The item stays until the prompt goes away, so it is asked once.
   */
  private async followUp(
    paneId: string,
    item: { runId: string; questionId: string; handled: boolean },
    attached: HostPromptsReport["attached"][number][],
  ): Promise<Result<void, MetatorError>> {
    const questions = await this.d.journal.questions(item.runId);
    if (questions.isErr()) return err(questions.error);
    const q = questions.value.find((x) => x.id === item.questionId);
    if (!q?.answer) return ok(undefined);
    if (q.answer.choices[0] === ATTACH_PANE) {
      const lock = await this.d.lock.attach({ runId: item.runId, by: q.answer.by });
      // Already attached (by them or another): the pane shows who; nothing to force.
      if (lock.isOk()) attached.push({ paneId, runId: item.runId, by: q.answer.by });
    }
    item.handled = true;
    return ok(undefined);
  }

  private async close(
    paneId: string,
    item: { runId: string; questionId: string },
    host: string,
  ): Promise<Result<void, MetatorError>> {
    this.open.delete(paneId);
    const questions = await this.d.journal.questions(item.runId);
    if (questions.isErr()) return err(questions.error);
    const q = questions.value.find((x) => x.id === item.questionId);
    if (q && !q.answer) {
      // Not one of the two choices: the pane itself says, in words, that the prompt is gone.
      const answered = await this.d.journal.answer(item.runId, item.questionId, {
        choices: [],
        text: ANSWERED_IN_PANE,
        by: `pane:${paneId}`,
      });
      if (answered.isErr()) return err(answered.error);
    }
    const noted = await this.d.journal.record(item.runId, {
      type: "agent",
      origin: "pty",
      agent: host,
      text: `the host prompt in pane ${paneId} went away`,
    });
    return noted.isErr() ? err(noted.error) : ok(undefined);
  }
}
