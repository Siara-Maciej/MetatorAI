/**
 * What a chat's screen keeps (ADR-0113): which thread it shows and the daemon it reads it from, and
 * its two acts. The screen keeps nothing else: every part reads its one fact of the thread, its
 * pane or its tasks from the daemon's state through this store, and draws again only when that
 * fact changed.
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import { confirmed } from "../../shared/confirm.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { boardCards } from "../../shared/model/board.ts";
import { closeThreadQuestion } from "../../shared/model/confirm.ts";
import { byAttentionFirst, type WorkTask, workTasks } from "../../shared/model/tasks.ts";
import { threadPane } from "../../shared/model/threads.ts";
import { scopedStore, useScoped } from "../../shared/state/scoped-store.ts";
import { actOnThread } from "./chat-actions.ts";

export interface ThreadState {
  readonly daemon: Store<Daemon>;
  readonly id: string;
  /** Close chat stops its agent: asked first while it lives (`ui.confirmClosePane`). */
  close(): Promise<void>;
  /** Reopen, Continue, Retry: the daemon continues the chat (its paused pane, its session, or a new one). */
  reopen(): Promise<void>;
}

export interface ThreadInit {
  readonly daemon: Store<Daemon>;
  readonly id: string;
}

export const Thread = scopedStore<ThreadState, ThreadInit>("Thread", ({ daemon, id }) => () => {
  const thread = () => daemon.getState().threads.find((t) => t.id === id);
  return {
    daemon,
    id,
    close: async () => {
      const d = daemon.getState();
      const t = thread();
      if (!t) return;
      const ask =
        (d.options.find((o) => o.key === "ui.confirmClosePane")?.value as boolean | undefined) ?? true;
      if (confirmed(closeThreadQuestion(t, threadPane(t, d.panes), ask))) await actOnThread(d, t, "close");
    },
    reopen: async () => {
      const t = thread();
      if (t) await actOnThread(daemon.getState(), t, "reopen");
    },
  };
});

const useThreadStore = <T>(select: (s: ThreadState) => T): T => useScoped(Thread, select);

/** One value of the daemon's state about the thread: the part draws again only when it changed. */
export const useThreadFact = <T>(select: (d: Daemon, id: string) => T): T => {
  const daemon = useThreadStore((s) => s.daemon);
  const id = useThreadStore((s) => s.id);
  return useStore(daemon, (d) => select(d, id));
};

/** The acts of the screen, read at the moment of a click. */
export const useThreadActs = (): Pick<ThreadState, "close" | "reopen"> => useThreadStore((s) => s);

/** The work as parent tasks, the ones that wait for you first (`useTasks`, from the screen's daemon). */
export function useThreadTasks(): readonly WorkTask[] {
  const runs = useThreadFact((d) => d.runs);
  const plans = useThreadFact((d) => d.systemPlans);
  return useMemo(
    () => byAttentionFirst(workTasks(boardCards({ runs, issues: [], plans, now: Date.now() }), plans)),
    [runs, plans],
  );
}
