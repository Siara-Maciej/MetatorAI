/**
 * The shell: a thin top bar, the sidebar that is the whole dashboard (what needs you, the chats
 * with their tasks, the other places, "+ New chat"), and the place the hash route names.
 * Notifications and the overview-on-return live here too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BacklogScreen } from "../features/backlog/backlog-screen.tsx";
import { BoardScreen } from "../features/board/board-screen.tsx";
import { InboxScreen } from "../features/inbox/inbox-screen.tsx";
import { AddRepoScreen } from "../features/repos/add-repo-screen.tsx";
import { ContainerDown } from "../features/repos/container-down.tsx";
import { FirstRun } from "../features/repos/first-run.tsx";
import { RepoSwitcher } from "../features/repos/repo-switcher.tsx";
import { shellView } from "../features/repos/repos.ts";
import { ReposProvider, useRepos } from "../features/repos/repos-context.tsx";
import { reviewNeeds } from "../features/reviews/model.ts";
import { ReviewsScreen } from "../features/reviews/reviews-screen.tsx";
import { NewSessionDialog } from "../features/runs/new-session.tsx";
import { RunScreen } from "../features/runs/run-screen.tsx";
import { AppSettings } from "../features/settings/app-settings.tsx";
import { SettingsScreen } from "../features/settings/settings-screen.tsx";
import { OverviewScreen } from "../features/system/overview-screen.tsx";
import { sendLine } from "../features/terminals/terminal.tsx";
import { WorkbenchScreen } from "../features/terminals/workbench-screen.tsx";
import { ThreadScreen } from "../features/threads/thread-screen.tsx";
import type { IssueRef, ThreadView } from "../shared/api/api.ts";
import { DaemonProvider, useDaemon } from "../shared/daemon/daemon.tsx";
import { keyMapOf, plainKey } from "../shared/model/keys.ts";
import {
  goesToPane,
  needsQueue,
  notifies,
  paneOfQuestion,
  pickedNeed,
  stepNeed,
} from "../shared/model/needs.ts";
import { flattenState, folderLabel, sameRepo } from "../shared/model/places.ts";
import { parseRoute, type Route, routeHash } from "../shared/model/route.ts";
import { hostChoice, noHostText, openRuns, runTabFor } from "../shared/model/runs.ts";
import { chatTitleOf, followedThread } from "../shared/model/threads.ts";
import { navigate } from "../shared/navigation.ts";
import { systemNotifier } from "../shared/platform/notify.ts";
import { useLatest } from "../shared/use-latest.ts";
import { Button } from "../ui/button.tsx";
import { Notice } from "../ui/notice.tsx";
import { createConfirmer } from "./confirm.ts";
import { HelpOverlay } from "./help-overlay.tsx";
import { afterAnswer, newQuestions, nextWaiting, wasAway } from "./model.ts";
import { NoDaemon } from "./no-daemon.tsx";
import { ScreenBoundary } from "./screen-boundary.tsx";
import { Sidebar } from "./sidebar.tsx";

export const App = () => (
  <DaemonProvider>
    <ReposProvider>
      <Shell />
    </ReposProvider>
  </DaemonProvider>
);

const notifier = systemNotifier();

function Shell() {
  const d = useDaemon(
    "changeName",
    "client",
    "connected",
    "down",
    "inbox",
    "me",
    "options",
    "paneAsks",
    "panes",
    "reloadThreads",
    "repo",
    "repos",
    "reviewCards",
    "run",
    "runs",
    "startError",
    "starting",
    "threads",
    "url",
    "who",
  );
  const repos = useRepos();
  // The folder in the top bar: its repositories, counted once however many worktrees each has.
  const folder = folderLabel(d.repos);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [dialog, setDialog] = useState(false);
  const [help, setHelp] = useState(false);
  // What an action of the shell answered (a run that could not start, an answer that went
  // through): it stays until closed.
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "info"; sticky?: boolean }>();
  // A confirmation goes by itself after a few seconds; a refusal stays until it is closed (D5).
  useEffect(() => {
    if (notice?.tone !== "info") return;
    const t = setTimeout(() => setNotice((n) => (n === notice ? undefined : n)), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  // Below about 1000 px the sidebar is a drawer behind a button of the top bar.
  const [panelOpen, setPanelOpen] = useState(false);
  // The draft of "New task from here…": held here, not in the hash, until the backlog is left.
  const [backlogDraft, setBacklogDraft] = useState<{ readonly refs?: readonly IssueRef[] }>();
  const go = useCallback((r: Route) => {
    navigate(r);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      // What an action of the last place said is about that place: it goes with it.
      // A confirmation set together with a move lives through that one move.
      setNotice((n) => (n?.tone !== "info" ? n : n.sticky ? { ...n, sticky: false } : undefined));
      setPanelOpen(false);
      if (next.screen !== "backlog") setBacklogDraft(undefined);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // The options come with the daemon's state, read once for the whole app.
  const options = useLatest(d.options);
  // Notifications: every question that was not there before (spec §5.4).
  const known = useRef<{ id: string; runId: string }[] | undefined>(undefined);
  useEffect(() => {
    const now = d.inbox.map((i) => i.question);
    const fresh = known.current ? newQuestions(known.current, now) : [];
    known.current = now.map((q) => ({ id: q.id, runId: q.runId }));
    if (fresh.length === 0) return;
    // `notify.channel: off` silences the system notification as it hides the Terminals' toast.
    if (!notifies(options.current)) return;
    for (const q of fresh) void notifier.notify("MetatorAI needs you", q.prompt);
  }, [d.inbox]);
  // Back after ten minutes: the overview of the run that was open comes first (spec §6.8).
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
        go({ screen: "run", runId: route.runId, tab: "overview" });
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
  }, [route, go]);
  /**
   * "+ New chat" (round 16): a thread and its chat terminal (the repository's conversation agent
   * in a pane of its own, `POST /threads`); the app goes to it. It is "New chat" until the agent
   * names it. Home's "Describe a task" starts one named after the person's words, which are typed
   * to the agent as its first line. The host is the first of the repository's `hostOrder` that is
   * installed (D1); with none installed, or when the daemon refuses, the app says so instead of
   * opening a chat that cannot work.
   */
  const { client, repo, down, url, me } = d;
  const reloadThreads = d.reloadThreads;
  const who = d.who;
  const newChat = useCallback(
    async (words?: string) => {
      if (down) return;
      const s = await client.supervisor(repo);
      if (!s.ok || !s.data) {
        setNotice({
          text: `No chat was started: ${s.error?.message ?? "the daemon did not answer"}`,
          tone: "error",
        });
        return;
      }
      const host = hostChoice(s.data.policy.hostOrder, s.data.hostStatus, s.data.hosts);
      if (!host) {
        setNotice({ text: noHostText(s.data.hostStatus ?? []), tone: "error" });
        return;
      }
      const by = await who();
      if (!by) return;
      const first = words?.trim() || undefined;
      const r = await client.newThread({ ...(first ? { title: chatTitleOf(first) } : {}), by, host }, repo);
      if (!r.ok || !r.data) {
        setNotice({
          text: `No chat was started: ${r.error?.message ?? "the daemon refused"}`,
          tone: "error",
        });
        return;
      }
      setNotice(undefined);
      await reloadThreads();
      go({ screen: "thread", id: r.data.thread.id });
      if (first) {
        const pane = r.data.pane;
        const refused = await sendLine("", url, me, repo, first, pane.id);
        if (refused) setNotice({ text: `The agent did not get your words: ${refused}`, tone: "error" });
      }
    },
    [client, repo, down, url, me, go, who, reloadThreads],
  );
  /** Close or reopen a thread (its ⋯ menu, its bar): closing ends its chat terminal, never its runs. */
  const threadAct = useCallback(
    async (thread: ThreadView, act: "close" | "reopen") => {
      const by = await who();
      if (!by) return;
      const r =
        act === "close"
          ? await client.closeThread(thread.id, by, thread.repo)
          : await client.reopenThread(thread.id, by, thread.repo);
      await reloadThreads();
      if (!r.ok) {
        setNotice({
          text: `The chat was not ${act === "close" ? "closed" : "reopened"}: ${r.error?.message ?? "the daemon refused"}`,
          tone: "error",
        });
        return;
      }
      setNotice(undefined);
      if (act === "reopen") go({ screen: "thread", id: thread.id });
    },
    [client, who, reloadThreads, go],
  );
  /**
   * A topic change: the agent opened a new thread from the one on screen (`metator thread new`);
   * the app goes to its chat once it appears. Threads known before are never followed.
   */
  const knownThreads = useRef<readonly string[] | undefined>(undefined);
  useEffect(() => {
    const ids = d.threads.map((t) => t.id);
    const before = knownThreads.current;
    knownThreads.current = ids;
    if (!before) return;
    const next = followedThread(before, d.threads, route.screen === "thread" ? route.id : undefined);
    if (next) go({ screen: "thread", id: next.id });
  }, [d.threads, route, go]);
  /**
   * "Attach and answer in the pane": the run whose pane the person answers in. Its Terminal tab
   * attaches, shows that pane, focuses it and scrolls to the question, then clears this.
   */
  const [answerIn, setAnswerIn] = useState<{ runId: string; pane?: string | undefined }>();
  // The confirmation of the latest answer only (confirm.ts): a slower one never speaks over it.
  const daemonNow = useLatest(d);
  const [confirmer] = useState(() =>
    createConfirmer({
      read: async (runId, repo) =>
        flattenState((await daemonNow.current.client.state()).data).runs.find(
          (x) => x.runId === runId && sameRepo(x.repo, repo),
        ),
      say: (text) => setNotice({ text, tone: "info", sticky: true }),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    }),
  );
  const runOf = d.run;
  const openRun = useCallback(
    (runId: string, attach = false, pane?: string) => {
      const run = runOf(runId);
      go({
        screen: "run",
        runId,
        tab: attach || pane ? "terminal" : run ? runTabFor(run) : "overview",
        ...(pane ? { pane } : {}),
      });
      if (attach) setAnswerIn({ runId, pane });
    },
    [go, runOf],
  );
  // Everything that needs the person: the sidebar counts it, Home shows one at a time. The
  // reviews' cards (round 18) come after the runs' questions.
  const needs = useMemo(
    () => [...needsQueue(d.inbox, d.runs, d.panes, d.paneAsks), ...reviewNeeds(d.reviewCards)],
    [d.inbox, d.runs, d.panes, d.paneAsks, d.reviewCards],
  );
  const picked = route.screen === "inbox" ? pickedNeed(needs, route.pick) : undefined;
  // Settings holds the places that are not daily work: the System.
  const settingsPart =
    route.screen === "overview"
      ? "system"
      : route.screen === "settings"
        ? "options"
        : route.screen === "app"
          ? "app"
          : undefined;
  // What the main area holds instead of the daemon's screens (round 20): the first run, Add
  // repository, the app's settings, or the panel that says the daemon is not there.
  const view = shellView({
    commands: repos.commands !== undefined,
    known: repos.known,
    down: d.down,
    screen: route.screen,
    current: repos.current,
    startFailed: d.startError !== undefined && !d.starting,
  });
  // With no repository yet there is nothing for the sidebar: the first run and Add stand alone.
  const solo = repos.commands !== undefined && repos.known?.length === 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the runs drawer; a dialog closes itself (the browser's own <dialog>, D7).
      if (e.key === "Escape") {
        setPanelOpen(false);
        return;
      }
      // A dialog has the keys while it is open.
      if (document.querySelector("dialog[open]")) return;
      const key = plainKey(e);
      if (key === "?") {
        // The key opens the help; it is not the first letter of its filter.
        e.preventDefault();
        setHelp(true);
      }
      if (key === "n") void newChat();
      if (route.screen === "inbox") {
        // The queue of decisions: j/k and the arrows move, g is the next one, o the run's overview.
        const step =
          key === "j" || key === "ArrowDown" || key === "g" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0;
        const next = step === 0 ? undefined : stepNeed(needs, route.pick, step);
        if (next) {
          e.preventDefault();
          go({ screen: "inbox", pick: next.key });
        }
        if (key === "o" && picked?.runId) go({ screen: "run", runId: picked.runId, tab: "overview" });
      } else if (key === "g") {
        const next = nextWaiting(d.runs, route.screen === "run" ? route.runId : undefined);
        if (next) openRun(next.runId, false, next.terminalAsk);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The place the route names: an expression, not a component, so a render keeps its state.
  const settingsNav = settingsPart ? (
    <nav className="settings-parts run-tabs" aria-label="parts of the settings">
      {(
        [
          ["options", "Options", routeHash({ screen: "settings" })],
          ["system", "System", routeHash({ screen: "overview", tab: "daemon" })],
          ["app", "App", routeHash({ screen: "app" })],
        ] as const
      ).map(([id, label, href]) => (
        <a key={id} href={href} aria-current={settingsPart === id ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  ) : null;
  const screen = (
    <>
      {settingsNav}
      {route.screen === "inbox" ? (
        <InboxScreen
          needs={needs}
          picked={picked}
          onPick={(pick) => go({ screen: "inbox", pick })}
          onRefused={(message) =>
            setNotice({ text: `The answer was not taken: ${message}`, tone: "error", sticky: true })
          }
          onAnswered={(choices, item) => {
            // "Attach and answer in the pane": the card took the answer; the person goes to the pane.
            const pane = item ? paneOfQuestion(item.question, d.panes) : undefined;
            if (item && goesToPane(item.question, choices?.[0])) {
              openRun(item.runId, true, pane);
              setNotice({
                text: "You hold the keyboard of the run: answer the host in its pane, then release it to the agent.",
                tone: "info",
                sticky: true,
              });
              return;
            }
            const back = afterAnswer(window.location.hash);
            if (back) go(back);
            if (!choices || !item) {
              setNotice(undefined);
              return;
            }
            // What the run did with the answer, read back: a Reject may have escalated it.
            void confirmer.confirm(choices, item);
          }}
          onOpenRun={(id, pane) => openRun(id, false, pane)}
          onOpenChanges={(runId) => go({ screen: "run", runId, tab: "changes" })}
          onOverview={(runId) => go({ screen: "run", runId, tab: "overview" })}
          onStart={(task) => void newChat(task)}
          onForm={() => setDialog(true)}
        />
      ) : null}
      {route.screen === "run" ? (
        <RunScreen
          runId={route.runId}
          tab={route.tab}
          pane={route.pane}
          file={route.file}
          go={go}
          onOpenRun={openRun}
          answerIn={answerIn?.runId === route.runId ? answerIn : undefined}
          onAnswering={() => setAnswerIn(undefined)}
        />
      ) : null}
      {route.screen === "grid" ? (
        <WorkbenchScreen
          onNewTask={() => void newChat()}
          onOpenSettings={() => go({ screen: "settings" })}
          onOpenPlan={(runId) => go({ screen: "run", runId, tab: "overview" })}
          onOpenReview={(runId) => go({ screen: "run", runId, tab: "changes" })}
          onHelp={() => setHelp(true)}
          onOpenInbox={(pick) => go({ screen: "inbox", pick })}
          onOpenBacklog={(draft) => {
            setBacklogDraft(draft);
            go({ screen: "backlog" });
          }}
          {...(route.pane ? { showPane: route.pane } : {})}
          task={route.task}
          session={route.session}
          group={route.group}
        />
      ) : null}
      {route.screen === "backlog" ? (
        <BacklogScreen id={route.id} onOpenSession={openRun} initialDraft={backlogDraft} />
      ) : null}
      {route.screen === "reviews" ? (
        <ReviewsScreen id={route.id} onOpen={(id) => go({ screen: "reviews", id })} onOpenSession={openRun} />
      ) : null}
      {route.screen === "overview" ? (
        <OverviewScreen
          tab={route.tab}
          onTab={(tab) => go({ screen: "overview", tab })}
          onOpenRun={openRun}
        />
      ) : null}
      {route.screen === "settings" ? <SettingsScreen /> : null}
      {route.screen === "thread" ? (
        <ThreadScreen
          id={route.id}
          onClose={(t) => void threadAct(t, "close")}
          onReopen={(t) => void threadAct(t, "reopen")}
        />
      ) : null}
      {route.screen === "board" ? <BoardScreen task={route.task} onOpenRun={(id) => openRun(id)} /> : null}
    </>
  );
  return (
    <div className={`shell${panelOpen ? " panel-open" : ""}${solo ? " solo" : ""}`}>
      <header className="topbar">
        <span className="logo">MetatorAI</span>
        {solo ? null : <RepoSwitcher served={folder} />}
        <Button className="panel-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>
          Runs · {openRuns(d.runs).length}
          {needs.length > 0 ? ` · ${needs.length} need you` : ""}
        </Button>
        <span className="spacer" />
        <Button
          variant="ghost"
          title="the keys of the app"
          aria-label="keyboard help"
          onClick={() => setHelp(true)}
        >
          ?
        </Button>
        {solo ? null : (
          <>
            <Button
              variant="ghost"
              className="who"
              title="Your name goes next to every answer you give. Click to change it."
              onClick={d.changeName}
            >
              {d.me ? `you: ${d.me}` : "set your name"}
            </Button>
            <span className={`conn ${d.connected ? "green" : "red"}`} data-testid="connection">
              {d.connected ? "connected" : d.down ? "no daemon" : "connecting…"}
            </span>
          </>
        )}
      </header>
      {solo ? null : (
        <Sidebar
          route={route}
          needs={needs}
          onRun={(r, pane) =>
            r.status === "escalated"
              ? go({ screen: "inbox", pick: `escalated:${r.repo ?? ""}:${r.runId}` })
              : openRun(r.runId, false, pane)
          }
          onInbox={() => go({ screen: "inbox" })}
          onNew={() => void newChat()}
          onForm={() => setDialog(true)}
          onThread={(t) => go({ screen: "thread", id: t.id })}
          onCloseThread={(t) => void threadAct(t, "close")}
          onReopenThread={(t) => void threadAct(t, "reopen")}
        />
      )}
      <main className="content">
        <Notice
          text={view === "screens" ? notice?.text : undefined}
          tone={notice?.tone ?? "error"}
          onClose={() => setNotice(undefined)}
        />
        {view === "first-run" ? <FirstRun /> : null}
        {view === "add" ? <AddRepoScreen /> : null}
        {view === "app-settings" ? (
          <>
            {settingsNav}
            <AppSettings />
          </>
        ) : null}
        {view === "no-daemon" ? <NoDaemon /> : null}
        {view === "container-down" ? <ContainerDown /> : null}
        {view === "screens" ? <ScreenBoundary place={routeHash(route)}>{screen}</ScreenBoundary> : null}
      </main>
      {help ? <HelpOverlay keymap={keyMapOf(d.options)} onClose={() => setHelp(false)} /> : null}
      {dialog && !d.down ? (
        <NewSessionDialog
          onClose={() => setDialog(false)}
          onCreated={(runId, attach) => {
            setDialog(false);
            if (attach) openRun(runId, true);
          }}
        />
      ) : null}
    </div>
  );
}
