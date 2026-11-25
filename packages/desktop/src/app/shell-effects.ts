/**
 * What the shell does by itself, apart from drawing: a system notification for every new question
 * (spec §5.4), the run's overview first when the person comes back after a while away (spec §6.8),
 * and the chat the agent opened from the one on screen, followed once.
 */
import { useEffect, useRef } from "react";
import { useDaemon } from "../shared/daemon/daemon.tsx";
import { notifies } from "../shared/model/needs.ts";
import type { Route } from "../shared/model/route.ts";
import { followedThread } from "../shared/model/threads.ts";
import { navigate } from "../shared/navigation.ts";
import { systemNotifier } from "../shared/platform/notify.ts";
import { useLatest } from "../shared/use-latest.ts";
import { newQuestions, wasAway } from "./model.ts";

const notifier = systemNotifier();

/** Every question that was not there before is a system notification, unless `notify.channel: off`. */
export function useQuestionNotifications(): void {
  const { inbox, options } = useDaemon("inbox", "options");
  const latestOptions = useLatest(options);
  const known = useRef<{ id: string; runId: string }[] | undefined>(undefined);
  useEffect(() => {
    const now = inbox.map((i) => i.question);
    const fresh = known.current ? newQuestions(known.current, now) : [];
    known.current = now.map((q) => ({ id: q.id, runId: q.runId }));
    if (fresh.length === 0 || !notifies(latestOptions.current)) return;
    for (const q of fresh) void notifier.notify("MetatorAI needs you", q.prompt);
  }, [inbox]);
}

/** Back after ten minutes on a run's page: its overview comes first. */
export function useBackAfterAway(route: Route): void {
  const lastSeen = useRef<number>(Date.now());
  useEffect(() => {
    const touch = () => {
      lastSeen.current = Date.now();
    };
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        wasAway(lastSeen.current, Date.now()) &&
        route.screen === "run"
      )
        navigate({ screen: "run", runId: route.runId, tab: "overview" });
      touch();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("keydown", touch);
    window.addEventListener("mousedown", touch);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("keydown", touch);
      window.removeEventListener("mousedown", touch);
    };
  }, [route]);
}

/**
 * A topic change: the agent opened a new thread from the one on screen (`metator thread new`);
 * the app goes to its chat once it appears. Threads known before are never followed.
 */
export function useFollowedThreads(route: Route): void {
  const { threads } = useDaemon("threads");
  const known = useRef<readonly string[] | undefined>(undefined);
  useEffect(() => {
    const before = known.current;
    known.current = threads.map((t) => t.id);
    if (!before) return;
    const next = followedThread(before, threads, route.screen === "thread" ? route.id : undefined);
    if (next) navigate({ screen: "thread", id: next.id });
  }, [threads, route]);
}
