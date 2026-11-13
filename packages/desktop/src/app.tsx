/**
 * The shell: a thin top bar, the sidebar that is the whole dashboard (what needs you, the runs,
 * the other places, the button that starts a run), and the place the hash route names.
 * Notifications and the overview-on-return live here too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IssueRef } from "./api.ts";
import { NoDaemon, Notice } from "./components/common.tsx";
import { HelpOverlay } from "./components/help-overlay.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { sendLine } from "./components/terminal.tsx";
import { DaemonProvider, useDaemon } from "./daemon.tsx";
import {
  answeredText,
  hostChoice,
  keyMapOf,
  type NeedRow,
  needsQueue,
  newQuestions,
  nextWaiting,
  noHostText,
  notifies,
  openRuns,
  parseRoute,
  pickedNeed,
  plainKey,
  type Route,
  routeHash,
  runTabFor,
  stepNeed,
  wasAway,
} from "./model.ts";
import { systemNotifier } from "./notify.ts";
import { BacklogScreen } from "./screens/backlog.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
import { MrsScreen } from "./screens/mrs.tsx";
import { NewSessionDialog } from "./screens/new-session.tsx";
import { OverviewScreen } from "./screens/overview.tsx";
import { RunScreen } from "./screens/run.tsx";
import { SettingsScreen } from "./screens/settings.tsx";
import { WorkbenchScreen } from "./screens/workbench.tsx";

export const App = () => (
  <DaemonProvider>
    <Shell />
  </DaemonProvider>
);

const notifier = systemNotifier();

function Shell() {
  const d = useDaemon();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [dialog, setDialog] = useState(false);
  const [help, setHelp] = useState(false);
  // What an action of the shell answered (a run that could not start, an answer that went
  // through): it stays until closed.
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "info" }>();
  // Below about 1000 px the sidebar is a drawer behind a button of the top bar.
  const [panelOpen, setPanelOpen] = useState(false);
  // The draft of "New task from here…": held here, not in the hash, until the backlog is left.
  const [backlogDraft, setBacklogDraft] = useState<{ readonly refs?: readonly IssueRef[] }>();
  const go = useCallback((r: Route) => {
    window.location.hash = routeHash(r);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      setPanelOpen(false);
      if (next.screen !== "backlog") setBacklogDraft(undefined);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // The options come with the daemon's state, read once for the whole app.
  const options = useRef(d.options);
  options.current = d.options;
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
   * "+ New run" (T1, design/14 §2): a pane with the orchestrator as the entry point in the "chat"
   * workspace; the person says what to do, the agent starts the run. With `task` (the first-run
   * field) those words are typed to the agent as its first line. The host is the first of the
   * repository's `hostOrder` that is installed (D1); with none installed, or when the daemon
   * refuses, the app says so instead of opening a tab that cannot work.
   */
  const { client, repo, down, url, me } = d;
  const openIntake = useCallback(
    async (task?: string) => {
      if (down) return;
      const s = await client.supervisor(repo);
      if (!s.ok || !s.data) {
        setNotice({
          text: `No run was started: ${s.error?.message ?? "the daemon did not answer"}`,
          tone: "error",
        });
        return;
      }
      const host = hostChoice(s.data.policy.hostOrder, s.data.hostStatus, s.data.hosts);
      if (!host) {
        setNotice({ text: noHostText(s.data.hostStatus ?? []), tone: "error" });
        return;
      }
      const p = await client.openPane(
        { label: "chat", newTab: true, role: "apps", agent: "mt-orchestrator", host },
        repo,
      );
      if (!p.ok || !p.data) {
        setNotice({ text: `No run was started: ${p.error?.message ?? "the daemon refused"}`, tone: "error" });
        return;
      }
      setNotice(undefined);
      go({ screen: "grid", pane: p.data.id });
      if (task) {
        const refused = await sendLine("", url, me, repo, task, p.data.id);
        if (refused) setNotice({ text: `The agent did not get your words: ${refused}`, tone: "error" });
      }
    },
    [client, repo, down, url, me, go],
  );
  const openRun = useCallback(
    (runId: string, attach = false, pane?: string) => {
      const run = d.run(runId);
      go({
        screen: "run",
        runId,
        tab: attach || pane ? "terminal" : run ? runTabFor(run) : "overview",
        ...(pane ? { pane } : {}),
      });
      if (attach) void d.who().then((by) => (by ? d.client.attach(runId, by, run?.repo) : undefined));
    },
    [go, d],
  );
  // Everything that needs the person: the sidebar lists it, the Inbox shows the picked one.
  const needs = useMemo(() => needsQueue(d.inbox, d.runs), [d.inbox, d.runs]);
  const picked = route.screen === "inbox" ? pickedNeed(needs, route.pick) : undefined;
  const openNeed = (n: NeedRow) =>
    n.kind === "terminal" ? openRun(n.runId, false, n.pane) : go({ screen: "inbox", pick: n.key });
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
      if (key === "n") void openIntake();
      if (route.screen === "inbox") {
        // The queue of decisions: j/k and the arrows move, g is the next one, o the run's overview.
        const step =
          key === "j" || key === "ArrowDown" || key === "g" ? 1 : key === "k" || key === "ArrowUp" ? -1 : 0;
        const next = step === 0 ? undefined : stepNeed(needs, route.pick, step);
        if (next) {
          e.preventDefault();
          go({ screen: "inbox", pick: next.key });
        }
        if (key === "o" && picked) go({ screen: "run", runId: picked.runId, tab: "overview" });
      } else if (key === "g") {
        const next = nextWaiting(d.runs, route.screen === "run" ? route.runId : undefined);
        if (next) openRun(next.runId, false, next.terminalAsk);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The place the route names: an expression, not a component, so a render keeps its state.
  const screen = (
    <>
      {route.screen === "inbox" ? (
        <InboxScreen
          needs={needs}
          picked={picked}
          onAnswered={(choices) => {
            setNotice(choices ? { text: answeredText(choices), tone: "info" } : undefined);
            go({ screen: "inbox" });
          }}
          onOpenRun={(id, pane) => openRun(id, false, pane)}
          onOpenChanges={(runId) => go({ screen: "run", runId, tab: "changes" })}
          onOverview={(runId) => go({ screen: "run", runId, tab: "overview" })}
          onStart={(task) => void openIntake(task)}
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
        />
      ) : null}
      {route.screen === "grid" ? (
        <WorkbenchScreen
          onNewTask={() => void openIntake()}
          onOpenSettings={() => go({ screen: "settings" })}
          onOpenPlan={(runId) => go({ screen: "run", runId, tab: "plan" })}
          onOpenReview={(runId) => go({ screen: "run", runId, tab: "changes" })}
          onHelp={() => setHelp(true)}
          onOpenInbox={(pick) => go({ screen: "inbox", pick })}
          onOpenBacklog={(draft) => {
            setBacklogDraft(draft);
            go({ screen: "backlog" });
          }}
          {...(route.pane ? { showPane: route.pane } : {})}
        />
      ) : null}
      {route.screen === "backlog" ? (
        <BacklogScreen onOpenSession={openRun} initialDraft={backlogDraft} />
      ) : null}
      {route.screen === "mrs" ? (
        <MrsScreen
          id={route.id}
          onOpen={(id) => go({ screen: "mrs", id })}
          onOpenSession={openRun}
          onOpenPlan={(runId) => go({ screen: "run", runId, tab: "plan" })}
        />
      ) : null}
      {route.screen === "overview" ? (
        <OverviewScreen
          tab={route.tab}
          onTab={(tab) => go({ screen: "overview", tab })}
          onOpenRun={openRun}
        />
      ) : null}
      {route.screen === "settings" ? <SettingsScreen /> : null}
    </>
  );
  return (
    <div className={`shell${panelOpen ? " panel-open" : ""}`}>
      <header className="topbar">
        <span className="logo">MetatorAI</span>
        <span className="dim scope">
          {d.repos.length > 0 ? `${d.repos.length} repositories` : "this repository"}
        </span>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          Runs · {openRuns(d.runs).length}
          {needs.length > 0 ? ` · ${needs.length} need you` : ""}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="ghost"
          title="the keys of the app"
          aria-label="keyboard help"
          onClick={() => setHelp(true)}
        >
          ?
        </button>
        <button
          type="button"
          className="ghost who"
          title="Your name goes next to every answer you give. Click to change it."
          onClick={d.changeName}
        >
          {d.me ? `you: ${d.me}` : "set your name"}
        </button>
        <span className={`conn ${d.connected ? "green" : "red"}`} data-testid="connection">
          {d.connected ? "connected" : d.down ? "no daemon" : "connecting…"}
        </span>
      </header>
      <Sidebar
        route={route}
        needs={needs}
        picked={picked?.key}
        onNeed={openNeed}
        onRun={(r, pane) =>
          r.status === "escalated"
            ? go({ screen: "inbox", pick: `escalated:${r.repo ?? ""}:${r.runId}` })
            : openRun(r.runId, false, pane)
        }
        onInbox={() => go({ screen: "inbox" })}
        onNew={() => void openIntake()}
        onForm={() => setDialog(true)}
      />
      <main className="content">
        <Notice
          text={d.down ? undefined : notice?.text}
          tone={notice?.tone ?? "error"}
          onClose={() => setNotice(undefined)}
        />
        {d.down ? <NoDaemon /> : screen}
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
