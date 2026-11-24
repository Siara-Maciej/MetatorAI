/** The Terminal tab of a run: its live session, who types, its panes, the question and the links. */

import { useEffect, useRef, useState } from "react";
import { Chip } from "../../shared/components/chips.tsx";
import { CommandText, commandOf } from "../../shared/components/command-text.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { plainKey } from "../../shared/model/keys.ts";
import { lookOf } from "../../shared/model/look.ts";
import {
  goesToPane,
  hostPromptOf,
  isTerminalQuestion,
  paneOfQuestion,
  questionKind,
} from "../../shared/model/needs.ts";
import { paneLabel, paneStateOf, panesOfRun } from "../../shared/model/panes.ts";
import { routeHash } from "../../shared/model/route.ts";
import type { Run } from "../../shared/model/runs.ts";
import { Notice } from "../../ui/notice.tsx";
import { Tabs } from "../../ui/tabs.tsx";
import { QuickAnswer } from "../inbox/answer.tsx";
import {
  PaneTerminal,
  RunTerminal,
  sendLine,
  type TerminalHandle,
  type TerminalStatus,
} from "../terminals/terminal.tsx";
import { portsText, runPhase } from "./model.ts";
import { useRunControls } from "./run-controls.ts";

export function TerminalTab({
  run,
  pane: wantedPane,
  answerIn,
  onAnswering,
  onOpenRun,
  onOpenChanges,
}: {
  readonly run: Run;
  /** The pane to show first (from the sidebar); the conductor otherwise. */
  readonly pane?: string | undefined;
  /** "Attach and answer in the pane": attach, show the pane, focus it, scroll to its question. */
  readonly answerIn?: { readonly pane?: string | undefined } | undefined;
  onAnswering?: (() => void) | undefined;
  onOpenRun(runId: string): void;
  onOpenChanges(runId: string): void;
}) {
  const { client, panesOf, url, me } = useDaemon("client", "panesOf", "url", "me");
  const runId = run.runId;
  const repo = run.repo;
  // In a folder two repositories may use the same pane ids: only the run's repository counts.
  const panes = panesOfRun(panesOf(repo), runId);
  const [chosenPane, setChosenPane] = useState<string | undefined>(wantedPane);
  useEffect(() => setChosenPane(wantedPane), [wantedPane]);
  const conductor = panes.find((p) => p.role === "conductor");
  const shown = chosenPane && panes.some((p) => p.id === chosenPane) ? chosenPane : conductor?.id;
  const [line, setLine] = useState("");
  const [termStatus, setTermStatus] = useState<TerminalStatus>({});
  const { data, reload: refresh } = usePolled(
    `links:${repo ?? ""}:${runId}`,
    async () => {
      const [m, c] = await Promise.all([client.messages(runId, repo), client.conflicts(repo)]);
      return {
        ok: true,
        data: {
          messages: m.data?.messages ?? [],
          conflicts: (c.data?.conflicts ?? []).filter((x) => x.runs.includes(runId)),
        },
      };
    },
    2000,
  );
  const messages = data?.messages ?? [];
  const conflicts = data?.conflicts ?? [];
  const action = useAction(refresh);
  const { attached, taken, attach, release, openEditor, closePane } = useRunControls(run, action);
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
  const phase = runPhase(run);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== "active" || document.querySelector("dialog[open]")) return;
      const k = plainKey(e);
      if (k === "a" && !attached) void attach();
      if (k === "c" && attached) void release();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // "Attach and answer in the pane" chosen here, in the run's own Question box.
  const [here, setHere] = useState<{ readonly pane?: string | undefined }>();
  const answering = answerIn ?? here;
  // Answering in a pane: attach once, then focus the pane's terminal at its last line (the question).
  const handle = useRef<TerminalHandle>(undefined);
  const view = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  // A new terminal handle renders again, so the effect below runs once the pane is there.
  const [, setHandleReady] = useState(0);
  useEffect(() => {
    if (!answering) {
      asked.current = false;
      return;
    }
    if (answering.pane && answering.pane !== chosenPane) setChosenPane(answering.pane);
    if (!attached) {
      if (!asked.current && !taken) {
        asked.current = true;
        void attach();
      }
      return;
    }
    if (!handle.current) return;
    handle.current.scrollToBottom();
    handle.current.focus();
    view.current?.scrollIntoView({ block: "end" });
    setHere(undefined);
    onAnswering?.();
  });
  const onReady = (h: TerminalHandle) => {
    handle.current = h;
    setHandleReady((n) => n + 1);
  };
  const question = run.questions[0];
  const host = question?.source === "permission" ? hostPromptOf(question.prompt) : undefined;
  return (
    <div className="session">
      <div className="main">
        {phase === "active" ? (
          <div className={`driverbar ${run.driver}`} data-testid="driverbar">
            <strong>
              Working:{" "}
              {run.driver === "human"
                ? `${run.attachedBy ?? "a person"}${attached ? " (you)" : ""}`
                : run.driving || live || hasTerminal
                  ? "agent"
                  : "nobody"}
            </strong>
            <span className="note">
              {run.driver === "human"
                ? "a yes in the chat counts as an approval while a person is attached"
                : run.driving || live || hasTerminal
                  ? "attach to type; approvals said in the chat do not count until then"
                  : "no agent works on this run and no session is open"}
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
        ) : null}
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
          {termStatus.alive === false && termStatus.exitCode !== undefined ? (
            <Chip tone="amber">session exited {termStatus.exitCode}</Chip>
          ) : null}
          <span className="spacer" />
          <button type="button" onClick={() => void openShell()}>
            + Shell
          </button>
        </Tabs>
        {shown && shown !== conductor?.id ? (
          <div ref={view} className="term-view">
            <PaneTerminal key={shown} paneId={shown} repo={repo} canType={attached} onReady={onReady} />
          </div>
        ) : hasTerminal ? (
          <div ref={view} className="term-view">
            <RunTerminal
              runId={runId}
              repo={repo}
              canType={attached}
              onStatus={setTermStatus}
              onReady={onReady}
            />
          </div>
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
            {phase === "active" ? null : (
              <a href={routeHash({ screen: "run", runId, tab: "activity" })}>Activity</a>
            )}
          </div>
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
              <div title={question.prompt}>
                <CommandText prompt={host?.text || question.prompt} command={commandOf(question)} />
              </div>
              {isTerminalQuestion(question) ? (
                <div className="dim" data-testid="host-asker">
                  {question.agent ?? "the agent"} asks on its terminal: an answer chosen here is typed there
                </div>
              ) : null}
              {host ? (
                <div className="dim" data-testid="host-asker">
                  {host.asker} asks on its terminal, in pane <span className="mono">{host.pane}</span>
                </div>
              ) : null}
              <QuickAnswer
                question={question}
                repo={repo}
                onDone={(choices) => {
                  if (goesToPane(question, choices[0])) setHere({ pane: paneOfQuestion(question, panes) });
                  void refresh();
                }}
              />
              {questionKind(question) === "PERMISSION" ? (
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
                {s.status} · {portsText(s.ports)}
              </span>
            </div>
          ))}
        </div>
        <div className="box">
          <h3>Changes</h3>
          <div className="row">
            <button type="button" className="ghost" onClick={() => onOpenChanges(runId)}>
              Open changes
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
              <button type="button" className="ghost mono" onClick={() => onOpenRun(run.parent as string)}>
                {run.parent}
              </button>
            </div>
          ) : null}
          {run.children?.map((c) => (
            <div key={c}>
              step{" "}
              <button type="button" className="ghost mono" onClick={() => onOpenRun(c)}>
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
