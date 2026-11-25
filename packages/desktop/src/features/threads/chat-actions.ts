/**
 * The chats' acts (round 16), from the sidebar, Home, the Terminals and the keys alike.
 * "+ New chat": a thread and its chat terminal (the repository's conversation agent in a pane of its
 * own, `POST /threads`); the app goes to it. Home's "Describe a task" starts one named after the
 * person's words, which are typed to the agent as its first line. The host is the first of the
 * repository's `hostOrder` that is installed (D1); with none, or when the daemon refuses, the app
 * says so instead of opening a chat that cannot work. Close and Reopen end or bring back a thread's
 * chat terminal, never its runs.
 */
import type { ThreadView } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { hostChoice, noHostText } from "../../shared/model/runs.ts";
import { chatTitleOf } from "../../shared/model/threads.ts";
import { navigate } from "../../shared/navigation.ts";
import { say } from "../../shared/notice.ts";
import { sendLine } from "../terminals/terminal.tsx";

export function useNewChat(): (words?: string) => Promise<void> {
  const { client, repo, down, url, me, who, reloadThreads } = useDaemon(
    "client",
    "repo",
    "down",
    "url",
    "me",
    "who",
    "reloadThreads",
  );
  return async (words) => {
    if (down) return;
    const s = await client.supervisor(repo);
    if (!s.ok || !s.data) {
      say({ text: `No chat was started: ${s.error?.message ?? "the daemon did not answer"}`, tone: "error" });
      return;
    }
    const host = hostChoice(s.data.policy.hostOrder, s.data.hostStatus, s.data.hosts);
    if (!host) {
      say({ text: noHostText(s.data.hostStatus ?? []), tone: "error" });
      return;
    }
    const by = await who();
    if (!by) return;
    const first = words?.trim() || undefined;
    const r = await client.newThread({ ...(first ? { title: chatTitleOf(first) } : {}), by, host }, repo);
    if (!r.ok || !r.data) {
      say({ text: `No chat was started: ${r.error?.message ?? "the daemon refused"}`, tone: "error" });
      return;
    }
    say(undefined);
    await reloadThreads();
    navigate({ screen: "thread", id: r.data.thread.id });
    if (first) {
      const refused = await sendLine("", url, me, repo, first, r.data.pane.id);
      if (refused) say({ text: `The agent did not get your words: ${refused}`, tone: "error" });
    }
  };
}

/** Close or reopen a thread (its ⋯ menu, its bar). */
export function useThreadAct(): (thread: ThreadView, act: "close" | "reopen") => Promise<void> {
  const { client, who, reloadThreads } = useDaemon("client", "who", "reloadThreads");
  return async (thread, act) => {
    const by = await who();
    if (!by) return;
    const r =
      act === "close"
        ? await client.closeThread(thread.id, by, thread.repo)
        : await client.reopenThread(thread.id, by, thread.repo);
    await reloadThreads();
    if (!r.ok) {
      say({
        text: `The chat was not ${act === "close" ? "closed" : "reopened"}: ${r.error?.message ?? "the daemon refused"}`,
        tone: "error",
      });
      return;
    }
    say(undefined);
    if (act === "reopen") navigate({ screen: "thread", id: thread.id });
  };
}
