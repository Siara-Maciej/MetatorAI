/**
 * What a run's Terminal tab keeps while it is open (ADR-0113): the pane chosen, the line being
 * typed, the run terminal's status, whether the run's own terminal is shown, "answer in the pane"
 * chosen here, and what the last action answered. The tab is made for one run (its provider is
 * keyed by the run); the run and its panes are read from the daemon's store at the moment of an act.
 */

import { useStore } from "zustand";
import { confirmed } from "../../shared/confirm.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import { readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { closePaneQuestion } from "../../shared/model/confirm.ts";
import { panesOfRun } from "../../shared/model/panes.ts";
import { type ActionState, IDLE, runAction, sayIn } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { actionIn } from "../terminals/store-action.ts";
import { sendLine, type TerminalHandle, type TerminalStatus } from "../terminals/terminal.tsx";
import { runControls } from "./run-controls.ts";

/** The polled request of the run's links (messages, conflicts): one key for every part. */
export const linksKey = (runId: string, repo: string | undefined): string => `links:${repo ?? ""}:${runId}`;

type PaneLike = {
  readonly id: string;
  readonly role: string;
  readonly live?: { readonly alive: boolean } | undefined;
};

/** What the tab shows of the run's panes: the pane shown, and whether there is anything to type into. */
export interface PaneFacts {
  /** The pane chosen while the run has it, else the conductor. */
  readonly shown: string | undefined;
  readonly conductor: string | undefined;
  /** The conductor's session lives. */
  readonly live: boolean;
  /** Nothing to type into: no run terminal shown here, and no other pane chosen. */
  readonly noTerminal: boolean;
  /** Nothing to type into, and none of the run's terminals lives (attaching would serve nothing). */
  readonly nothingLives: boolean;
}

export function paneFacts(
  panes: readonly PaneLike[],
  chosen: string | undefined,
  opened: boolean,
): PaneFacts {
  const conductor = panes.find((p) => p.role === "conductor");
  const shown = chosen && panes.some((p) => p.id === chosen) ? chosen : conductor?.id;
  const noTerminal = !opened && !(shown && shown !== conductor?.id);
  return {
    shown,
    conductor: conductor?.id,
    live: conductor?.live?.alive === true,
    noTerminal,
    nothingLives: noTerminal && !panes.some((p) => p.live?.alive),
  };
}

/** The person holds the run's keyboard; someone does. */
export const attachedTo = (
  run: { readonly driver?: string; readonly attachedBy?: string | undefined } | undefined,
  me: string,
): boolean => run?.driver === "human" && run.attachedBy === me && me !== "";

export interface TerminalTabState extends ActionState {
  /** The daemon's store the tab was opened with: its parts read the run and its panes through it. */
  readonly daemon: Store<Daemon>;
  /** The pane the person chose (or the route's); the conductor when none. */
  readonly chosen: string | undefined;
  /** The route's pane: another one wins over the one chosen. */
  readonly wanted: string | undefined;
  readonly line: string;
  readonly status: TerminalStatus;
  /**
   * The run's own terminal is shown once its session lived while the tab is open. Coming to the tab
   * never starts a process: a run without a session says so and offers "Open a session".
   */
  readonly opened: boolean;
  /** "Attach and answer in the pane" chosen here, in the run's own Question box. */
  readonly here: { readonly pane?: string | undefined } | undefined;
  /** A new terminal handle: what waits for it (answering in the pane) looks again. */
  readonly ready: number;

  /** Follows the daemon while the tab is open (the run's session living); the result stops it. */
  connect(): () => void;
  routeTo(pane: string | undefined): void;
  choose(pane: string | undefined): void;
  type(line: string): void;
  setStatus(status: TerminalStatus): void;
  answerHere(pane: string | undefined): void;
  answered(): void;
  setHandle(h: TerminalHandle): void;
  handle(): TerminalHandle | undefined;
  attach(): Promise<boolean>;
  release(): Promise<boolean>;
  openShell(): Promise<void>;
  /** A pane's ✕: asked first while it lives (`ui.confirmClosePane`). */
  close(id: string): Promise<void>;
  /** The composer's Send: attach first; else the line to the pane shown (or the run's terminal). */
  send(): Promise<void>;
  /** The links read again now. */
  reloadLinks(): Promise<void>;
  closeNotice(): void;
}

export interface TerminalTabInit {
  readonly daemon: Store<Daemon>;
  readonly runId: string;
  readonly repo: string | undefined;
  /** The pane to show first (from the sidebar); the conductor otherwise. */
  readonly pane: string | undefined;
}

export const TerminalTab = scopedStore<TerminalTabState, TerminalTabInit>(
  "TerminalTab",
  ({ daemon, runId, repo, pane }) =>
    (set, get, api) => {
      const d = () => daemon.getState();
      // In a folder two repositories may use the same pane ids: only the run's repository counts.
      const panes = () => panesOfRun(d().panesOf(repo), runId);
      const reload = () => readAgainNow(d().url, linksKey(runId, repo));
      const controls = () =>
        runControls(d().client, actionIn(api, daemon, false, reload), d().me, d().run(runId, repo));
      const live = () => panes().find((p) => p.role === "conductor")?.live?.alive === true;
      let handle: TerminalHandle | undefined;
      return {
        ...IDLE,
        daemon,
        chosen: pane,
        wanted: pane,
        line: "",
        status: {},
        opened: live(),
        here: undefined,
        ready: 0,

        connect: () => {
          const see = () => {
            if (!get().opened && live()) set({ opened: true });
          };
          see();
          return daemon.subscribe(see);
        },
        routeTo: (next) => {
          if (next !== get().wanted) set({ wanted: next, chosen: next });
        },
        choose: (id) => set({ chosen: id }),
        type: (line) => set({ line }),
        setStatus: (status) => set({ status }),
        answerHere: (id) => set({ here: { pane: id } }),
        answered: () => set({ here: undefined }),
        setHandle: (h) => {
          handle = h;
          set((s) => ({ ready: s.ready + 1 }));
        },
        handle: () => handle,
        attach: () => controls().attach(),
        release: () => controls().release(),
        openShell: async () => {
          let id: string | undefined;
          await runAction(
            api,
            daemon,
            async () => {
              const r = await d().client.openPane({ runId, role: "shell", label: "shell" }, repo);
              id = r.data?.id;
              return r;
            },
            { reload },
          );
          if (id) set({ chosen: id });
        },
        close: async (id) => {
          const ask =
            (d().options.find((o) => o.key === "ui.confirmClosePane")?.value as boolean | undefined) ?? true;
          const p = panes().find((x) => x.id === id);
          if (!confirmed(p ? closePaneQuestion(p, ask) : undefined)) return;
          if ((await controls().closePane(id)) && get().chosen === id) set({ chosen: undefined });
        },
        send: async () => {
          const { me, url } = d();
          if (!attachedTo(d().run(runId, repo), me)) {
            await get().attach();
            return;
          }
          const facts = paneFacts(panes(), get().chosen, get().opened);
          const refused = await sendLine(runId, url, me, repo, get().line, facts.shown ?? facts.conductor);
          sayIn(api, refused);
          if (!refused) set({ line: "" });
        },
        reloadLinks: reload,
        closeNotice: () => sayIn(api, undefined),
      };
    },
);

/** One value of the tab's state: the part draws again only when it changed. */
export const useTerminalTab = <T>(select: (s: TerminalTabState) => T): T => useScoped(TerminalTab, select);
/** The store at the moment of an event: no subscription. */
export const useTerminalTabApi = () => useScopedApi(TerminalTab);
/** The tab's daemon store, to read at the moment of an event. */
export const useTabDaemonStore = (): Store<Daemon> => useTerminalTab((s) => s.daemon);
/** One value of the daemon's state: the part draws again only when it changed. */
export const useTabDaemon = <T>(select: (d: Daemon) => T): T => useStore(useTabDaemonStore(), select);
