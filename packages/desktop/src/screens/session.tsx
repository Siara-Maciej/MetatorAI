/** Screen 2: one session, its terminal or its events, the driver lock, the question and the links. */
import { useEffect, useState } from "react";
import { ActivityList } from "../components/activity-list.tsx";
import { QuickAnswer } from "../components/answer.tsx";
import { Chip } from "../components/chips.tsx";
import { Notice } from "../components/common.tsx";
import { EscalatedActions } from "../components/escalated-card.tsx";
import { RunHeader } from "../components/run-header.tsx";
import { Tabs } from "../components/tabs.tsx";
import { PaneTerminal, RunTerminal, sendLine, type TerminalStatus } from "../components/terminal.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction, useRunControls } from "../hooks.ts";
import {
  autonomyLabel,
  duration,
  finishedText,
  lookOf,
  paneLabel,
  paneStateOf,
  panesOfRun,
  plainKey,
  runPhase,
} from "../model.ts";

export function SessionScreen({
  runId,
  pane: wantedPane,
  onOpenSession,
  onOpenReview,
}: {
  readonly runId: string;
  /** The pane to show first (from the sessions panel); the conductor otherwise. */
  readonly pane?: string | undefined;
  onOpenSession(runId: string): void;
  /** The run's change with the notes on it (S5). */
  onOpenReview(runId: string): void;
}) {
  const { client, run: runOf, panesOf, url, me } = useDaemon();
  const run = runOf(runId);
  const repo = run?.repo;
  // In a folder two repositories may use the same pane ids: only the run's repository counts.
  const panes = panesOfRun(panesOf(repo), runId);
  const [chosenPane, setChosenPane] = useState<string | undefined>(wantedPane);
  useEffect(() => setChosenPane(wantedPane), [wantedPane]);
  const conductor = panes.find((p) => p.role === "conductor");
  const shown = chosenPane && panes.some((p) => p.id === chosenPane) ? chosenPane : conductor?.id;
  const [tab, setTab] = useState<"terminal" | "events">("terminal");
  const [line, setLine] = useState("");
  const [termStatus, setTermStatus] = useState<TerminalStatus>({});
  const { data, reload: refresh } = usePolled(
    `session:${repo ?? ""}:${runId}`,
    async () => {
      const [a, m, c] = await Promise.all([
        client.activity(runId, repo),
        client.messages(runId, repo),
        client.conflicts(repo),
      ]);
      return {
        ok: true,
        data: {
          events: a.data?.entries ?? [],
          messages: m.data?.messages ?? [],
          conflicts: (c.data?.conflicts ?? []).filter((x) => x.runs.includes(runId)),
        },
      };
    },
    2000,
  );
  const events = data?.events ?? [];
  const messages = data?.messages ?? [];
  const conflicts = data?.conflicts ?? [];
  const action = useAction(refresh);
  const { attached, taken, attach, release, openEditor, closePane, openSession } = useRunControls(
    run,
    action,
  );
  /**
   * The run's own terminal is shown once its session lives, or once the person opened one here.
   * Coming to this screen never starts a process: a run driven in the background, or one that
   * has no session yet, says so and offers "Open a session".
   */
  const [terminalOf, setTerminalOf] = useState<string>();
  const live = conductor?.live?.alive === true;
  useEffect(() => {
    if (live) setTerminalOf(runId);
  }, [live, runId]);
  const hasTerminal = terminalOf === runId;
  const open = async () => {
    if (await openSession()) setTerminalOf(runId);
  };
  const openShell = async () => {
    let pane: string | undefined;
    await action.run(async () => {
      const r = await client.openPane({ runId, role: "shell", label: "shell" }, repo);
      pane = r.data?.id;
      return r;
    });
    if (pane) setChosenPane(pane);
  };
  const close = async (id: string) => {
    if ((await closePane(id)) && chosenPane === id) setChosenPane(undefined);
  };
  const send = async () => {
    if (!attached) {
      await attach();
      return;
    }
    const refused = await sendLine(runId, url, me, repo, line, shown ?? conductor?.id);
    action.say(refused);
    if (!refused) setLine("");
  };
  const phase = run ? runPhase(run) : "active";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = plainKey(e);
      if (phase === "active") {
        if (k === "a" && !attached) void attach();
        if (k === "c" && attached) void release();
      }
      if (k === "t") setTab(tab === "terminal" ? "events" : "terminal");
      if (k === "e") void openEditor();
      if (k === "d") onOpenReview(runId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!run) return <div className="empty">run {runId} is not in the state yet</div>;
  const question = run.questions[0];
  return (
    <div className="session">
      <div className="main">
        <RunHeader runId={runId} run={run} screen="session">
          <div className="chips">
            {repo ? <Chip>{repo}</Chip> : null}
            <Chip>{run.workflow}</Chip>
            <Chip>{autonomyLabel(run.autonomy)}</Chip>
            <Chip tone="violet">{run.host ?? "no host"}</Chip>
            {run.worktree?.ports ? (
              <Chip>
                ports {run.worktree.ports.from}–{run.worktree.ports.from + run.worktree.ports.count - 1}
              </Chip>
            ) : null}
            <Chip>{duration(run.elapsedMs)}</Chip>
            {run.died ? <Chip tone="red">drive died</Chip> : null}
            {termStatus.alive === false && termStatus.exitCode !== undefined ? (
              <Chip tone="amber">session exited {termStatus.exitCode}</Chip>
            ) : null}
          </div>
        </RunHeader>
        {phase === "escalated" ? (
          <div className="driverbar escalated" data-testid="driverbar">
            <strong>Escalated at {run.stage}</strong>
            <span className="note" data-testid="escalated-reason">
              {run.reason ?? "The run recorded no reason. Its briefing shows what happened last."}
            </span>
            <EscalatedActions run={run} />
          </div>
        ) : phase === "finished" ? (
          <div className={`driverbar finished ${run.status}`} data-testid="driverbar">
            <strong>{run.status === "done" ? "Done" : "Aborted"}</strong>
            <span className="note">{finishedText(run)}</span>
            <button type="button" onClick={() => onOpenReview(runId)}>
              Changes
            </button>
          </div>
        ) : (
          <div className={`driverbar ${run.driver}`} data-testid="driverbar">
            <strong>
              Working:{" "}
              {run.driver === "human"
                ? `${run.attachedBy ?? "a person"}${attached ? " (you)" : ""}`
                : "agent"}
            </strong>
            <span className="note">
              {run.driver === "human"
                ? "a yes in the chat counts as an approval while a person is attached"
                : "attach to type; approvals said in the chat do not count until then"}
            </span>
            {attached ? (
              <button type="button" onClick={() => void release()}>
                Release to agent · c
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void attach()} disabled={taken}>
                Attach · a
              </button>
            )}
          </div>
        )}
        <Notice {...action.notice} />
        {run.terminalAsk ? (
          <div className="banner ask-banner" data-testid="terminal-ask">
            <span className="msg">
              The agent asks in its terminal{attached ? ": type your answer there." : ". Attach to answer."}
            </span>
            {run.terminalAsk !== shown ? (
              <button type="button" onClick={() => setChosenPane(run.terminalAsk)}>
                Show the pane
              </button>
            ) : null}
          </div>
        ) : null}
        <Tabs
          label="terminal or events"
          current={tab}
          onSelect={(id) => setTab(id)}
          items={[
            { id: "terminal", label: "Terminal" },
            { id: "events", label: `Events · ${events.length}` },
          ]}
        >
          <span className="spacer" />
          <span className="dim">e editor · t events · d changes</span>
        </Tabs>
        {tab === "terminal" ? (
          <>
            <Tabs
              label="panes"
              className="panes"
              testId="panes"
              current={shown}
              onSelect={setChosenPane}
              items={panes.map((p) => ({
                id: p.id,
                label: paneLabel(p),
                title: `${p.id} · ${p.state?.reason ?? ""}`,
                after: (
                  <>
                    <Chip tone={lookOf("pane", paneStateOf(p)).tone}>{paneStateOf(p)}</Chip>
                    {p.role !== "conductor" ? (
                      <button
                        type="button"
                        className="ghost"
                        title={`close ${p.id}`}
                        aria-label={`close ${p.id}`}
                        onClick={() => void close(p.id)}
                      >
                        ✕
                      </button>
                    ) : null}
                  </>
                ),
              }))}
            >
              <span className="spacer" />
              <button type="button" onClick={() => void openShell()}>
                + Shell
              </button>
            </Tabs>
            {shown && shown !== conductor?.id ? (
              <PaneTerminal key={shown} paneId={shown} repo={repo} canType={attached} />
            ) : hasTerminal ? (
              <RunTerminal runId={runId} repo={repo} canType={attached} onStatus={setTermStatus} />
            ) : (
              <div className="empty no-session" data-testid="no-session">
                <h2>No session runs for this run</h2>
                <p>
                  {phase === "active"
                    ? run.driving
                      ? "An agent works on it in the background, without a terminal. Opening a session starts the host in a terminal of its own."
                      : "Nothing works on it. Opening a session starts the host in a terminal."
                    : phase === "escalated"
                      ? "The run stopped. Resume it above; its events say what happened."
                      : "The run is finished. Its events and its changes are what is left."}
                </p>
                {phase === "active" ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={action.busy}
                    onClick={() => void open()}
                  >
                    Open a session
                  </button>
                ) : (
                  <button type="button" onClick={() => setTab("events")}>
                    Events
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <ActivityList entries={events} variant="table" />
        )}
        {phase === "active" ? (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              aria-label="message to the session"
              placeholder={
                attached
                  ? "type to the session · y / a / p / n are shortcuts the host knows"
                  : "attach to type (click here attaches)"
              }
              value={line}
              onFocus={() => {
                if (!attached && !taken) void attach();
              }}
              onChange={(e) => setLine(e.target.value)}
            />
            <button type="submit" disabled={!attached}>
              Send
            </button>
          </form>
        ) : null}
      </div>
      <aside className="side">
        <div className="box">
          <h3>Question</h3>
          {question ? (
            <>
              <div className="clamp" title={question.prompt}>
                {question.prompt}
              </div>
              <QuickAnswer question={question} repo={repo} onDone={() => void refresh()} />
              {question.source === "permission" ? (
                <div className="dim">
                  The host asks in its terminal. To give the same answer every time, answer with{" "}
                  <code>metator run answer --always</code>.
                </div>
              ) : null}
            </>
          ) : run.terminalAsk ? (
            <div className="muted">the agent asks in its terminal: answer there</div>
          ) : phase === "escalated" ? (
            <div className="muted">the run escalated: resume or close it in the bar above</div>
          ) : phase === "finished" ? (
            <div className="muted">nothing: the run is {run.status}</div>
          ) : (
            <div className="muted">nothing waits for you here</div>
          )}
        </div>
        <div className="box">
          <h3>Apps</h3>
          {run.services.length === 0 ? <div className="muted">no services for this worktree</div> : null}
          {run.services.map((s) => (
            <div className="svc" key={s.service}>
              <span>{s.service}</span>
              <span className="dim">
                {s.status} · {s.ports.join(", ") || "no port"}
              </span>
            </div>
          ))}
        </div>
        <div className="box">
          <h3>Changes</h3>
          <div className="row">
            <button type="button" className="ghost" onClick={() => onOpenReview(runId)}>
              Review
            </button>
            <button type="button" className="ghost" onClick={() => void openEditor()}>
              Open in editor
            </button>
          </div>
          {run.worktree ? (
            <div className="muted">
              {run.worktree.branch} · <code>{run.worktree.path}</code>
            </div>
          ) : (
            <div className="muted">works in the main checkout</div>
          )}
          {run.last ? (
            <div className="dim">
              last: {run.last.type} · {run.last.text.slice(0, 120)}
            </div>
          ) : null}
        </div>
        <div className={`box${conflicts.length > 0 ? " warn" : ""}`}>
          <h3>Links</h3>
          {run.parent ? (
            <div>
              parent{" "}
              <button
                type="button"
                className="ghost mono"
                onClick={() => onOpenSession(run.parent as string)}
              >
                {run.parent}
              </button>
            </div>
          ) : null}
          {run.children?.map((c) => (
            <div key={c}>
              step{" "}
              <button type="button" className="ghost mono" onClick={() => onOpenSession(c)}>
                {c}
              </button>
            </div>
          ))}
          {conflicts.map((c) => (
            <div key={c.files.join()} className="muted">
              shares {c.files.join(", ")} with <code>{c.runs.find((r) => r !== runId)}</code> · merge{" "}
              {c.mergeFirst} first
            </div>
          ))}
          {messages.length === 0 && !run.parent && !run.children?.length && conflicts.length === 0 ? (
            <div className="muted">no links</div>
          ) : null}
          <ul>
            {messages.map((m) => (
              <li key={m.id}>
                <span className="dim">
                  {m.topic} from {m.fromRun} ·{" "}
                </span>
                {m.text}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
