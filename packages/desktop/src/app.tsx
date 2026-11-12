/**
 * The shell (spec §5.1): the top bar with the counters and the attention budget, the rail, the
 * sessions panel, and the screen the hash route names. Notifications and the briefing-on-return
 * live here too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueRef } from "./api.ts";
import { NoDaemon, Notice } from "./components/common.tsx";
import { SessionsPanel } from "./components/sessions-panel.tsx";
import { DaemonProvider, useDaemon } from "./daemon.tsx";
import {
  escalatedKey,
  hostChoice,
  isFinished,
  newQuestions,
  nextWaiting,
  noHostText,
  notifies,
  parseRoute,
  plainKey,
  type Route,
  routeHash,
  wasAway,
} from "./model.ts";
import { systemNotifier } from "./notify.ts";
import { BacklogScreen } from "./screens/backlog.tsx";
import { BriefingScreen } from "./screens/briefing.tsx";
import { GraphScreen } from "./screens/graph.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
import { MrsScreen } from "./screens/mrs.tsx";
import { NewSessionDialog } from "./screens/new-session.tsx";
import { PlanScreen } from "./screens/plan.tsx";
import { ReviewScreen } from "./screens/review.tsx";
import { SessionScreen } from "./screens/session.tsx";
import { SettingsScreen } from "./screens/settings.tsx";
import { SupervisorScreen } from "./screens/supervisor.tsx";
import { WorkbenchScreen } from "./screens/workbench.tsx";

const RAIL: { route: Route; label: string; glyph: string }[] = [
  { route: { screen: "inbox" }, label: "Inbox", glyph: "☰" },
  { route: { screen: "grid" }, label: "Work", glyph: "▦" },
  { route: { screen: "backlog" }, label: "Backlog", glyph: "☷" },
  { route: { screen: "mrs" }, label: "MRs", glyph: "⇄" },
  { route: { screen: "graph" }, label: "Graph", glyph: "⌘" },
  { route: { screen: "supervisor" }, label: "Daemon", glyph: "◎" },
  { route: { screen: "settings" }, label: "Settings", glyph: "⚙" },
];

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
  // What an action of the shell answered (a session that could not open): it stays until closed.
  const [notice, setNotice] = useState<string>();
  // Below about 1000 px the sessions panel is a drawer behind a button of the top bar.
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
  // Notifications: every question that was not there before (spec §5.4).
  const known = useRef<{ id: string; runId: string }[] | undefined>(undefined);
  useEffect(() => {
    const now = d.inbox.map((i) => i.question);
    const fresh = known.current ? newQuestions(known.current, now) : [];
    known.current = now.map((q) => ({ id: q.id, runId: q.runId }));
    if (fresh.length === 0) return;
    // `notify.channel: off` silences the system notification as it hides the workbench's toast.
    void d.client.options(d.repo).then((r) => {
      if (!notifies(r.data?.options ?? [])) return;
      for (const q of fresh) void notifier.notify("MetatorAI needs you", q.prompt);
    });
  }, [d.inbox, d.client, d.repo]);
  // Back after ten minutes: the briefing of a session opened first (spec §6.8).
  const lastSeen = useRef<number>(Date.now());
  useEffect(() => {
    const touch = () => {
      lastSeen.current = Date.now();
    };
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        wasAway(lastSeen.current, Date.now()) &&
        route.screen === "session"
      )
        go({ screen: "briefing", runId: route.runId });
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
   * "+ New session" (T1, design/14 §2): a pane with the orchestrator as the entry point in the
   * "chat" workspace; the person talks, the agent starts the run. The host is the first of the
   * repository's `hostOrder` that is installed (D1); with none installed, or when the daemon
   * refuses, the app says so instead of opening a tab that cannot work.
   */
  const { client, repo, down } = d;
  const openIntake = useCallback(async () => {
    if (down) return;
    const s = await client.supervisor(repo);
    if (!s.ok || !s.data) {
      setNotice(`No session was opened: ${s.error?.message ?? "the daemon did not answer"}`);
      return;
    }
    const host = hostChoice(s.data.policy.hostOrder, s.data.hostStatus, s.data.hosts);
    if (!host) {
      setNotice(noHostText(s.data.hostStatus ?? []));
      return;
    }
    const p = await client.openPane(
      { label: "chat", newTab: true, role: "apps", agent: "mt-orchestrator", host },
      repo,
    );
    if (p.ok && p.data) {
      setNotice(undefined);
      go({ screen: "grid", pane: p.data.id });
    } else setNotice(`No session was opened: ${p.error?.message ?? "the daemon refused"}`);
  }, [client, repo, down, go]);
  const openSession = useCallback(
    (runId: string, attach = false, pane?: string) => {
      go({ screen: "session", runId, ...(pane ? { pane } : {}) });
      const run = d.runs.find((r) => r.runId === runId);
      if (attach) void d.who().then((by) => (by ? d.client.attach(runId, by, run?.repo) : undefined));
    },
    [go, d],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the dialog from anywhere, a focused field included (D7).
      if (e.key === "Escape") {
        setDialog(false);
        setPanelOpen(false);
        return;
      }
      const key = plainKey(e);
      if (key === "g" && route.screen !== "inbox") {
        const next = nextWaiting(d.runs, route.screen === "session" ? route.runId : undefined);
        if (next) openSession(next.runId, false, next.terminalAsk);
      }
      if (key === "n" && !dialog) void openIntake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, d.runs, dialog, openSession, openIntake]);
  const counts = {
    you: d.runs.filter((r) => r.attention === "you").length,
    driving: d.runs.filter((r) => r.attention === "driving").length,
    escalated: d.runs.filter((r) => r.attention === "escalated").length,
  };
  const current =
    route.screen === "session" ||
    route.screen === "briefing" ||
    route.screen === "plan" ||
    route.screen === "review"
      ? route.runId
      : undefined;
  // The screen the route names: an expression, not a component, so a render keeps its state.
  const screen = (
    <>
      {route.screen === "inbox" ? (
        <InboxScreen
          pick={route.pick}
          onOpenSession={(id, pane) => openSession(id, false, pane)}
          onOpenChanges={(runId) => go({ screen: "review", runId })}
          onBriefing={(id) => go({ screen: "briefing", runId: id })}
        />
      ) : null}
      {route.screen === "session" ? (
        <SessionScreen
          runId={route.runId}
          pane={route.pane}
          onOpenSession={openSession}
          onOpenReview={(runId) => go({ screen: "review", runId })}
        />
      ) : null}
      {route.screen === "grid" ? (
        <WorkbenchScreen
          onNewTask={() => void openIntake()}
          onOpenSettings={() => go({ screen: "settings" })}
          onOpenPlan={(runId) => go({ screen: "plan", runId })}
          onOpenReview={(runId) => go({ screen: "review", runId })}
          onOpenInbox={(pick) => go({ screen: "inbox", pick })}
          onOpenBacklog={(draft) => {
            setBacklogDraft(draft);
            go({ screen: "backlog" });
          }}
          {...(route.pane ? { showPane: route.pane } : {})}
        />
      ) : null}
      {route.screen === "review" ? (
        <ReviewScreen
          runId={route.runId}
          file={route.file}
          onOpenFile={(runId, file) => go({ screen: "review", runId, ...(file ? { file } : {}) })}
          onOpenSession={openSession}
        />
      ) : null}
      {route.screen === "backlog" ? (
        <BacklogScreen onOpenSession={openSession} initialDraft={backlogDraft} />
      ) : null}
      {route.screen === "plan" ? (
        <PlanScreen
          runId={route.runId}
          onOpenPane={(pane) => go({ screen: "grid", pane })}
          onOpenSession={openSession}
        />
      ) : null}
      {route.screen === "mrs" ? (
        <MrsScreen
          id={route.id}
          onOpen={(id) => go({ screen: "mrs", id })}
          onOpenSession={openSession}
          onOpenPlan={(runId) => go({ screen: "plan", runId })}
        />
      ) : null}
      {route.screen === "graph" ? <GraphScreen /> : null}
      {route.screen === "supervisor" ? (
        <SupervisorScreen onOpenSession={openSession} onNew={() => void openIntake()} />
      ) : null}
      {route.screen === "settings" ? <SettingsScreen /> : null}
      {route.screen === "briefing" ? (
        <BriefingScreen runId={route.runId} onOpenSession={openSession} />
      ) : null}
    </>
  );
  return (
    <div className={`shell${panelOpen ? " panel-open" : ""}`}>
      <header className="topbar">
        <span className="logo">MetatorAI</span>
        <span className="dim">
          {d.repos.length > 0 ? `${d.repos.length} repositories` : "this repository"}
        </span>
        <span className="counters" data-testid="counters">
          <span className="chip amber" title="runs that wait for your answer">
            need you {counts.you}
          </span>
          <span className="chip violet" title="runs an agent works on">
            working {counts.driving}
          </span>
          <span className="chip red" title="runs that stopped and need work from you">
            escalated {counts.escalated}
          </span>
        </span>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          Runs · {d.runs.filter((r) => !isFinished(r)).length}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="ghost who"
          title="Your name goes next to every answer you give. Click to change it."
          onClick={d.changeName}
        >
          {d.me ? `you: ${d.me}` : "set your name"}
        </button>
        <span className={`chip ${d.connected ? "green" : "red"}`} data-testid="connection">
          {d.connected ? "connected" : d.down ? "no daemon" : "connecting…"}
        </span>
      </header>
      <nav className="rail" aria-label="screens">
        {RAIL.map((r) => (
          <a
            key={r.label}
            href={routeHash(r.route)}
            aria-current={route.screen === r.route.screen ? "page" : undefined}
          >
            <div style={{ fontSize: 16 }}>{r.glyph}</div>
            {r.label}
          </a>
        ))}
        {current ? (
          <a
            href={routeHash({ screen: "session", runId: current })}
            aria-current={route.screen === "session" ? "page" : undefined}
          >
            <div style={{ fontSize: 16 }}>▣</div>
            Session
          </a>
        ) : null}
      </nav>
      <SessionsPanel
        current={current}
        onOpen={(id, pane) => openSession(id, false, pane)}
        onEscalated={(r) => go({ screen: "inbox", pick: escalatedKey(r) })}
        onNew={() => void openIntake()}
        onAdvanced={() => setDialog(true)}
      />
      <main className="content">
        <Notice text={d.down ? undefined : notice} onClose={() => setNotice(undefined)} />
        {d.down ? <NoDaemon /> : screen}
      </main>
      {dialog && !d.down ? (
        <NewSessionDialog
          onClose={() => setDialog(false)}
          onCreated={(runId, attach) => {
            setDialog(false);
            if (attach) openSession(runId, true);
          }}
        />
      ) : null}
    </div>
  );
}
