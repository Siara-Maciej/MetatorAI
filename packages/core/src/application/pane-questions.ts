import { labelFor, type QuestionAnswer } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock } from "../ports/index.ts";
import { OTHER } from "./run-journal.ts";

/**
 * A question a pane without a run asks a person (ADR-0091): its host's prompt (Claude Code asking
 * leave to run a command in the intake chat) or the words an agent asks there. It belongs to the
 * pane, not to a run, so the inbox shows it by its pane and repository.
 */
export interface PaneQuestion {
  /** `p001`, `p002`, …: one count for the repository's panes while the daemon runs. */
  readonly id: string;
  readonly paneId: string;
  /** permission: the host's own prompt; agent: the agent in the pane asks in words. */
  readonly source: "agent" | "permission";
  /** Who asks: the pane's label (`chat`), else its host. */
  readonly agent: string;
  readonly host: string;
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: false;
  readonly askedAt: string;
  readonly answer?: QuestionAnswer;
}

/**
 * The questions of panes without a run, kept by the daemon while it runs (one per repository). A
 * restarted daemon asks again what its panes still show, so nothing here needs to outlive it.
 */
export class PaneQuestions {
  private readonly asked = new Map<string, PaneQuestion>();
  private count = 0;

  constructor(private readonly clock: Clock) {}

  ask(input: Omit<PaneQuestion, "id" | "askedAt" | "answer" | "multiSelect">): PaneQuestion {
    this.count++;
    const q: PaneQuestion = {
      id: `p${String(this.count).padStart(3, "0")}`,
      ...input,
      multiSelect: false,
      askedAt: this.clock.now().toISOString(),
    };
    this.asked.set(key(q.paneId, q.id), q);
    return q;
  }

  get(paneId: string, id: string): PaneQuestion | undefined {
    return this.asked.get(key(paneId, id));
  }

  /** The questions no one answered yet, oldest first. */
  open(): readonly PaneQuestion[] {
    return [...this.asked.values()].filter((q) => !q.answer);
  }

  /** The answer, checked as a run question's is: a name, and choices the question offers (or words for Other). */
  answer(
    paneId: string,
    id: string,
    input: { readonly choices: readonly string[]; readonly text?: string; readonly by: string },
  ): Result<PaneQuestion, MetatorError> {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who answers: --by <name>", "An answer records who gave it."));
    const q = this.get(paneId, id);
    if (!q) return err(MetatorError.notFound(`question ${id} of pane ${paneId}`));
    if (q.answer) return err(MetatorError.usage(`question ${id} of pane ${paneId} is already answered`));
    const labels = q.options.map((o) => o.label);
    const choices =
      input.choices.length === 0 && input.text && labels.includes(OTHER)
        ? [OTHER]
        : input.choices.map((c) => labelFor(labels, c));
    if (choices.length === 0 || choices.some((c) => !labels.includes(c)))
      return err(
        MetatorError.usage(`choose from: ${labels.join(", ")}`, "Give a choice, or words for Other."),
      );
    const answered: PaneQuestion = {
      ...q,
      answer: {
        choices,
        ...(input.text ? { text: input.text } : {}),
        by: input.by,
        at: this.clock.now().toISOString(),
      },
    };
    this.asked.set(key(paneId, id), answered);
    return ok(answered);
  }

  /** A pane's prompt went away unanswered: the pane answered it (the person typed there). */
  answeredInPane(paneId: string, id: string, text: string, choices: readonly string[] = []): void {
    const q = this.get(paneId, id);
    if (!q || q.answer) return;
    this.asked.set(key(paneId, id), {
      ...q,
      answer: {
        choices: [...choices],
        ...(text ? { text } : {}),
        by: `pane:${paneId}`,
        at: this.clock.now().toISOString(),
      },
    } as PaneQuestion);
  }

  /** A closed pane's questions: no inbox item outlives its pane. */
  forget(paneId: string): void {
    for (const [k, q] of this.asked) if (q.paneId === paneId) this.asked.delete(k);
  }
}

const key = (paneId: string, id: string) => `${paneId}\u0000${id}`;
