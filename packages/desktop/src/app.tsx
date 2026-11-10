/**
 * The shell (spec §5.1): the top bar with the counters and the attention budget, the rail, the
 * sessions panel, and the screen the hash route names. Notifications and the briefing-on-return
 * live here too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SessionsPanel } from "./components/sessions-panel.tsx";
import { DaemonProvider, useDaemon } from "./daemon.tsx";
import { newQuestions, nextWaiting, parseRoute, type Route, routeHash, wasAway } from "./model.ts";
import { systemNotifier } from "./notify.ts";
import { BacklogScreen } from "./screens/backlog.tsx";
import { BriefingScreen } from "./screens/briefing.tsx";
import { GraphScreen } from "./screens/graph.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
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
  { route: { screen: "graph" }, label: "Graph", glyph: "⌘" },
  { route: { screen: "supervisor" }, label: "Super", glyph: "◎" },
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
  const go = useCallback((r: Route) => {
    window.location.hash = routeHash(r);
  }, []);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Notifications: every question that was not there before (spec §5.4).
  const known = useRef<{ id: string; runId: string }[] | undefined>(undefined);
  useEffect(() => {
    const now = d.inbox.map((i) => i.question);
    if (known.current)
      for (const q of newQuestions(known.current, now)) void notifier.notify("MetatorAI needs you", q.prompt);
    known.current = now.map((q) => ({ id: q.id, runId: q.runId }));
  }, [d.inbox]);
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
  const openSession = useCallback(
    (runId: string, attach = false) => {
      go({ screen: "session", runId });
      if (attach && d.me) void d.client.attach(runId, d.me, d.runs.find((r) => r.runId === runId)?.repo);
    },
    [go, d],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.key === "g" && route.screen !== "inbox") {
        const next = nextWaiting(d.runs, route.screen === "session" ? route.runId : undefined);
        if (next) openSession(next.runId);
      }
      if (e.key === "n" && !dialog) setDialog(true);
      if (e.key === "Escape") setDialog(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route, d.runs, dialog, openSession]);
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
  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">MetatorAI</span>
        <span className="dim">
          {d.repos.length > 0 ? `${d.repos.length} repositories` : "this repository"}
        </span>
        <span className="counters" data-testid="counters">
          <span className="chip amber">need you {counts.you}</span>
          <span className="chip violet">driving {counts.driving}</span>
          <span className="chip red">escalated {counts.escalated}</span>
        </span>
        <span className="chip" title="attention budget">
          {counts.you} waiting
        </span>
        <span className="spacer" />
        <span className={`chip ${d.connected ? "green" : "red"}`} data-testid="connection">
          {d.connected ? "connected" : d.error ? `daemon: ${d.error}` : "connecting…"}
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
        onOpen={(id, pane) => (pane ? go({ screen: "session", runId: id, pane }) : openSession(id))}
        onNew={() => setDialog(true)}
        onGrid={(group) => go({ screen: "grid", ...(group ? { group } : {}) })}
      />
      <main className="content">
        {route.screen === "inbox" ? (
          <InboxScreen
            onOpenSession={openSession}
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
            onNewTask={() => setDialog(true)}
            onOpenSettings={() => go({ screen: "settings" })}
            onOpenPlan={(runId) => go({ screen: "plan", runId })}
            onOpenReview={(runId) => go({ screen: "review", runId })}
            onOpenBacklog={(draft) => go({ screen: "backlog", ...(draft ? { draft } : {}) })}
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
          <BacklogScreen onOpenSession={openSession} initialDraft={route.draft} />
        ) : null}
        {route.screen === "plan" ? (
          <PlanScreen
            runId={route.runId}
            onOpenPane={(pane) => go({ screen: "grid", pane })}
            onOpenSession={openSession}
          />
        ) : null}
        {route.screen === "graph" ? <GraphScreen /> : null}
        {route.screen === "supervisor" ? (
          <SupervisorScreen onOpenSession={openSession} onNew={() => setDialog(true)} />
        ) : null}
        {route.screen === "settings" ? <SettingsScreen /> : null}
        {route.screen === "briefing" ? (
          <BriefingScreen runId={route.runId} onOpenSession={openSession} />
        ) : null}
      </main>
      {dialog ? (
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
