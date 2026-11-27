/**
 * Answering a question (D8, ADR-0113): which options are chosen (several for a multi-select
 * question), the person's own words where Reject or Other promise them, whether the request runs
 * and what a refusal said, in a store made for one question (`AnswerScope` in answer.tsx makes
 * it again for another). A part reads only what it draws: typing the words draws the field, not the options.
 */
import type { Question } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { opensDiff } from "../../shared/model/stage1.ts";
import { navigate } from "../../shared/navigation.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { canAnswer, needsReason, toggleChoice } from "./model.ts";

/** What a send does after the daemon answered: the caller's, read at the moment of the send. */
export interface SendOptions {
  /** The options sent; the chosen ones when none. */
  readonly picked?: readonly string[] | undefined;
  /** The reason given elsewhere on the card (Ask for changes), instead of the words field. */
  readonly words?: string | undefined;
  /** The answer went through, with what was chosen. */
  onDone(choices: readonly string[]): void;
  /** The answer was refused: what the daemon said (the card may close before it is read). */
  onRefused?: ((message: string) => void) | undefined;
}

export interface AnswerState {
  /** The daemon's store: the person's name a part shows, by selector. */
  readonly daemon: Store<Daemon>;
  readonly choices: readonly string[];
  readonly text: string;
  readonly busy: boolean;
  /** What the daemon said of a refused answer. */
  readonly error: string | undefined;
  /** The artifact of the run the card shows (a decision card's "see: …"). */
  readonly viewing: string | undefined;

  toggle(label: string): void;
  setText(text: string): void;
  clearError(): void;
  view(name: string | undefined): void;
  send(options: SendOptions): Promise<void>;
}

export interface AnswerInit {
  readonly daemon: Store<Daemon>;
  readonly question: Question;
  readonly repo: string | undefined;
  /** What is chosen before the person touches anything (the card: the recommended option). */
  readonly initial: readonly string[];
  /** From the decision card, without opening the session: what the daemon counts. */
  readonly origin?: "inbox" | undefined;
}

export const Answer = scopedStore<AnswerState, AnswerInit>(
  "Answer",
  ({ daemon, question: q, repo, initial, origin }) =>
    (set, get) => ({
      daemon,
      choices: initial,
      text: "",
      busy: false,
      error: undefined,
      viewing: undefined,

      toggle: (label) => set((s) => ({ choices: toggleChoice(s.choices, label, q.multiSelect) })),
      setText: (text) => set({ text }),
      clearError: () => set({ error: undefined }),
      view: (viewing) => set({ viewing }),
      send: async ({ picked = get().choices, words, onDone, onRefused }) => {
        // "Open diff" on a quick change's card is no answer: the run's change opens, the card stays.
        if (opensDiff(picked)) {
          navigate({ screen: "run", runId: q.runId, tab: "changes" });
          return;
        }
        const said = words ?? get().text;
        if (get().busy || !canAnswer(picked, said)) return;
        const { client, who } = daemon.getState();
        const by = await who();
        if (!by) return;
        set({ busy: true });
        const r = await client.answer(
          { runId: q.runId, question: q.id, choices: picked, by, text: said.trim() || undefined, origin },
          repo,
        );
        set({ busy: false });
        if (!r.ok) {
          const message = r.error?.message ?? "the answer was refused";
          set({ error: message });
          onRefused?.(message);
        } else {
          set({ error: undefined });
          onDone(picked);
        }
      },
    }),
);

/** One value of the answer's state: the part draws again only when it changed. */
export const useAnswer = <T>(select: (s: AnswerState) => T): T => useScoped(Answer, select);
/** The answer's store at the moment of an event: no subscription. */
export const useAnswerApi = () => useScopedApi(Answer);

/** The chosen options promise the person's own words. */
export const reasonOf = (s: AnswerState): boolean => needsReason(s.choices);
/** The answer can be sent now. */
export const readyOf = (s: AnswerState): boolean => canAnswer(s.choices, s.text) && !s.busy;
/** The chosen options as one string (a part draws again only when the choice changed). */
export const chosenOf = (s: AnswerState): string => s.choices.join(", ");
