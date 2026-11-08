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
import { BriefingScreen } from "./screens/briefing.tsx";
import { GraphScreen } from "./screens/graph.tsx";
import { InboxScreen } from "./screens/inbox.tsx";
import { NewSessionDialog } from "./screens/new-session.tsx";
import { SessionScreen } from "./screens/session.tsx";
import { SupervisorScreen } from "./screens/supervisor.tsx";
import { TerminalsScreen } from "./screens/terminals.tsx";

const RAIL: { route: Route; label: string; glyph: string }[] = [
  { route: { screen: "inbox" }, label: "Inbox", glyph: "☰" },
  { route: { screen: "grid" }, label: "Grid", glyph: "▦" },
  { route: { screen: "graph" }, label: "Graph", glyph: "⌘" },
  { route: { screen: "supervisor" }, label: "Super", glyph: "◎" },
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
  const [settings, setSettings] = useState(false);
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
  const current = route.screen === "session" || route.screen === "briefing" ? route.runId : undefined;
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
        <button
          type="button"
          className="ghost"
          aria-pressed={settings}
          onClick={() => setSettings(!settings)}
          title="daemon address and your name"
        >
          ⚙
        </button>
        {settings ? (
          <span className="settings">
            <input aria-label="daemon url" defaultValue={d.url} onBlur={(e) => d.setUrl(e.target.value)} />
            <input
              aria-label="your name"
              placeholder="your name"
              defaultValue={d.me}
              onBlur={(e) => d.setMe(e.target.value)}
              style={{ width: 120 }}
            />
          </span>
        ) : null}
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
        onOpen={(id) => openSession(id)}
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
          <SessionScreen runId={route.runId} onOpenSession={openSession} />
        ) : null}
        {route.screen === "grid" ? (
          <TerminalsScreen
            {...(route.group ? { group: route.group } : {})}
            onOpenSession={openSession}
            onNew={() => setDialog(true)}
          />
        ) : null}
        {route.screen === "graph" ? <GraphScreen /> : null}
        {route.screen === "supervisor" ? (
          <SupervisorScreen onOpenSession={openSession} onNew={() => setDialog(true)} />
        ) : null}
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
