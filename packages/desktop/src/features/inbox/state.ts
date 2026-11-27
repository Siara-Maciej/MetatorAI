/**
 * What Home's cards keep while they are shown (ADR-0113), each card its own store: an escalated
 * run's Resume and Close (the stage, the note, the reason, what the daemon answered), a pane's
 * question (the choice, the person's words, the message unfolded), and Home itself (the task being
 * described, the start of a run nothing drives). A part reads only the value it draws.
 */
import type { PaneAsk } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import type { Run } from "../../shared/model/runs.ts";
import { type ActionState, IDLE, runAction, sayIn } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { resumeNotice } from "./model.ts";

/* ---------- an escalated run ---------- */

export interface EscalatedState extends ActionState {
  /** The stage it resumes at: where it stopped, or an earlier one it worked. */
  readonly to: string;
  /** A note for the agent that works next. */
  readonly note: string;
  /** The Close form is open. */
  readonly closing: boolean;
  /** Why the run is closed (required). */
  readonly reason: string;

  setTo(stage: string): void;
  setNote(note: string): void;
  setReason(reason: string): void;
  toggleClosing(): void;
  closeNotice(): void;
  /**
   * Resumes `run` and drives it; `onDone` once something drives it. Resumed with nothing to
   * drive it, the person must know: the card stays and says so.
   */
  resume(run: Run, onDone?: (() => void) | undefined): Promise<void>;
  /** Ends `run` as aborted with the reason; `onDone` once it is closed. */
  close(run: Run, onDone?: (() => void) | undefined): Promise<void>;
}

export interface EscalatedInit {
  readonly daemon: Store<Daemon>;
  /** Where the run stopped: the stage chosen first. */
  readonly stage: string;
}

export const Escalated = scopedStore<EscalatedState, EscalatedInit>(
  "Escalated",
  ({ daemon, stage }) =>
    (set, get, api) => ({
      ...IDLE,
      to: stage,
      note: "",
      closing: false,
      reason: "",

      setTo: (to) => set({ to }),
      setNote: (note) => set({ note }),
      setReason: (reason) => set({ reason }),
      toggleClosing: () => set((s) => ({ closing: !s.closing })),
      closeNotice: () => set({ notice: undefined }),
      resume: async (run, onDone) => {
        if (get().busy) return;
        let notice: string | undefined;
        const ok = await runAction(
          api,
          daemon,
          async (by) => {
            const { to, note } = get();
            const r = await daemon
              .getState()
              .client.resume(run.runId, by, run.repo, { ...(to === run.stage ? {} : { to }), note });
            notice = r.ok ? resumeNotice(run.runId, r.data?.drive) : undefined;
            return r;
          },
          { who: true, refused: "the run was not resumed" },
        );
        if (!ok) return;
        if (notice) sayIn(api, notice);
        else onDone?.();
      },
      close: async (run, onDone) => {
        const reason = get().reason.trim();
        if (get().busy || reason === "") return;
        const ok = await runAction(
          api,
          daemon,
          () => daemon.getState().client.abort(run.runId, reason, run.repo),
          {
            refused: "the run was not closed",
          },
        );
        if (ok) onDone?.();
      },
    }),
);

/** One value of an escalated run's card: the part draws again only when it changed. */
export const useEscalated = <T>(select: (s: EscalatedState) => T): T => useScoped(Escalated, select);
/** The card's store at the moment of an event. */
export const useEscalatedApi = () => useScopedApi(Escalated);

/* ---------- a pane's question ---------- */

/** The choice that sends the person to the pane instead of answering here. */
const ATTACH = "Attach and answer in the pane";

export interface PaneAskState extends ActionState {
  readonly choice: string | undefined;
  /** The person's own words, for Other. */
  readonly words: string;
  /** The agent's whole message is unfolded. */
  readonly open: boolean;

  choose(choice: string): void;
  setWords(words: string): void;
  toggleOpen(): void;
  closeNotice(): void;
  /** Types the choice (or the words) into the pane; Attach then opens it. */
  send(
    ask: PaneAsk,
    onAnswered: (choices: readonly string[]) => void,
    onOpenPane: (ask: PaneAsk) => void,
  ): Promise<void>;
}

export const PaneAskStore = scopedStore<PaneAskState, { readonly daemon: Store<Daemon> }>(
  "PaneAsk",
  ({ daemon }) =>
    (set, get, api) => ({
      ...IDLE,
      choice: undefined,
      words: "",
      open: false,

      choose: (choice) => set({ choice }),
      setWords: (words) => set({ words }),
      toggleOpen: () => set((s) => ({ open: !s.open })),
      closeNotice: () => set({ notice: undefined }),
      send: async (ask, onAnswered, onOpenPane) => {
        const { choice, words } = get();
        if (!choice) return;
        const other = choice === "Other";
        const done = await runAction(
          api,
          daemon,
          (by) =>
            daemon.getState().client.answerPane(
              {
                paneId: ask.paneId,
                question: ask.question.id,
                choices: other ? [] : [choice],
                by,
                ...(other ? { text: words.trim() } : {}),
              },
              ask.repo,
            ),
          { who: true },
        );
        if (!done) return;
        if (choice === ATTACH) onOpenPane(ask);
        onAnswered(other ? [words.trim()] : [choice]);
      },
    }),
);

/** One value of a pane question's card. */
export const usePaneAsk = <T>(select: (s: PaneAskState) => T): T => useScoped(PaneAskStore, select);
/** The card's store at the moment of an event. */
export const usePaneAskApi = () => useScopedApi(PaneAskStore);

/* ---------- Home ---------- */

export interface HomeState extends ActionState {
  readonly daemon: Store<Daemon>;
  /** The task the person describes ("Describe a task"). */
  readonly task: string;

  setTask(task: string): void;
  closeNotice(): void;
}

export const Home = scopedStore<HomeState, { readonly daemon: Store<Daemon> }>(
  "Home",
  ({ daemon }) =>
    (set) => ({
      ...IDLE,
      daemon,
      task: "",

      setTask: (task) => set({ task }),
      closeNotice: () => set({ notice: undefined }),
    }),
);

/** One value of Home's state. */
export const useHome = <T>(select: (s: HomeState) => T): T => useScoped(Home, select);
/** Home's store at the moment of an event. */
export const useHomeApi = () => useScopedApi(Home);
