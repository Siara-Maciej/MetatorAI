/**
 * The shell (spec §5.1): the top bar with the counters and the attention budget, the rail, the
 * sessions panel, and the screen the hash route names. Notifications and the briefing-on-return
 * live here too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueRef } from "./api.ts";
import { SessionsPanel } from "./components/sessions-panel.tsx";
import { DaemonProvider, useDaemon } from "./daemon.tsx";
import { newQuestions, nextWaiting, notifies, parseRoute, type Route, routeHash, wasAway } from "./model.ts";
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
  // The draft of "New task from here…": held here, not in the hash, until the backlog is left.
  const [backlogDraft, setBacklogDraft] = useState<{ readonly refs?: readonly IssueRef[] }>();
  const go = useCallback((r: Route) => {
    window.location.hash = routeHash(r);
  }, []);
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
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
    void d.client.options(d.repos[0]?.name).then((r) => {
      if (!notifies(r.data?.options ?? [])) return;
      for (const q of fresh) void notifier.notify("MetatorAI needs you", q.prompt);
    });
  }, [d.inbox, d.client, d.repos]);
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
   * "intake" workspace; the person talks, the agent starts the run. The host is the first of the
   * repository's `hostOrder` that is installed, as the form would pick.
   */
  const openIntake = useCallback(async () => {
    const s = await d.client.supervisor(d.repos[0]?.name);
    const host = s.ok
      ? (s.data?.policy.hostOrder.find((h) => s.data?.hosts.includes(h)) ?? s.data?.hosts[0])
      : undefined;
    const p = await d.client.openPane(
      {
        label: "intake",
        newTab: true,
        role: "apps",
        agent: "mt-orchestrator",
        ...(host ? { host } : {}),
      },
      d.repos[0]?.name,
    );
    if (p.ok && p.data) go({ screen: "grid", pane: p.data.id });
  }, [d.client, d.repos, go]);
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
      if (e.key === "n" && !dialog) void openIntake();
      if (e.key === "Escape") setDialog(false);
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
        onNew={() => void openIntake()}
        onAdvanced={() => setDialog(true)}
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
            onNewTask={() => void openIntake()}
            onOpenSettings={() => go({ screen: "settings" })}
            onOpenPlan={(runId) => go({ screen: "plan", runId })}
            onOpenReview={(runId) => go({ screen: "review", runId })}
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
