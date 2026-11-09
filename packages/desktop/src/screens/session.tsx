/** Screen 2: one session, its terminal or its events, the driver lock, the question and the links. */
import { useCallback, useEffect, useState } from "react";
import type { Activity, Conflict, RunMessage } from "../api.ts";
import { Chip } from "../components/chips.tsx";
import { StageBar } from "../components/stage-bar.tsx";
import { PaneTerminal, RunTerminal, sendLine, type TerminalStatus } from "../components/terminal.tsx";
import { useDaemon } from "../daemon.tsx";
import { clock, duration, paneLabel, panesOfRun, type Run, stateTone } from "../model.ts";

export function SessionScreen({
  runId,
  pane: wantedPane,
  onOpenSession,
}: {
  readonly runId: string;
  /** The pane to show first (from the sessions panel); the conductor otherwise. */
  readonly pane?: string | undefined;
  onOpenSession(runId: string): void;
}) {
  const { client, runs, panes: allPanes, url, me, setMe } = useDaemon();
  const run = runs.find((r) => r.runId === runId);
  const repo = run?.repo;
  const panes = panesOfRun(allPanes, runId);
  const [chosenPane, setChosenPane] = useState<string | undefined>(wantedPane);
  useEffect(() => setChosenPane(wantedPane), [wantedPane]);
  // The conductor's tab is the run's own terminal (opened by the daemon when none is live).
  const conductor = panes.find((p) => p.role === "conductor");
  const shown = chosenPane && panes.some((p) => p.id === chosenPane) ? chosenPane : conductor?.id;
  const openShell = async () => {
    const r = await client.openPane({ runId, role: "shell", label: "shell", argv: [shellOf()] }, repo);
    if (r.ok && r.data) setChosenPane(r.data.id);
    else setNote(r.error?.message);
  };
  const closePane = async (id: string) => {
    const r = await client.closePane(id, repo);
    if (!r.ok) setNote(r.error?.message);
    else if (chosenPane === id) setChosenPane(undefined);
  };
  const [tab, setTab] = useState<"terminal" | "events">("terminal");
  const [events, setEvents] = useState<readonly Activity[]>([]);
  const [messages, setMessages] = useState<readonly RunMessage[]>([]);
  const [conflicts, setConflicts] = useState<readonly Conflict[]>([]);
  const [line, setLine] = useState("");
  const [note, setNote] = useState<string>();
  const [termStatus, setTermStatus] = useState<TerminalStatus>({});
  const [name, setName] = useState(me);
  const attached = run?.driver === "human" && run.attachedBy === me && me !== "";
  const refresh = useCallback(async () => {
    const [a, m, c] = await Promise.all([
      client.activity(runId, repo),
      client.messages(runId, repo),
      client.conflicts(repo),
    ]);
    if (a.ok && a.data) setEvents(a.data.entries);
    if (m.ok && m.data) setMessages(m.data.messages);
    if (c.ok && c.data) setConflicts(c.data.conflicts.filter((x) => x.runs.includes(runId)));
  }, [client, runId, repo]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);
  const attach = async () => {
    const who = name.trim();
    if (!who) {
      setNote("say who you are first");
      return;
    }
    setMe(who);
    const r = await client.attach(runId, who, repo);
    setNote(r.ok ? undefined : r.error?.message);
  };
  const release = async () => {
    const r = await client.release(runId, repo);
    setNote(r.ok ? undefined : r.error?.message);
  };
  const send = async () => {
    if (!attached) {
      await attach();
      return;
    }
    const refused = await sendLine(runId, url, me, repo, line, shown !== conductor?.id ? shown : undefined);
    setNote(refused);
    if (!refused) setLine("");
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "a" && !attached) void attach();
      if (e.key === "c" && attached) void release();
      if (e.key === "t") setTab(tab === "terminal" ? "events" : "terminal");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!run) return <div className="empty">run {runId} is not in the state yet</div>;
  const question = run.questions[0];
  return (
    <div className="session">
      <div className="main">
        <div className="head">
          <h2>{run.task}</h2>
          <div className="id mono">{run.runId}</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {repo ? <Chip>{repo}</Chip> : null}
            <Chip>{run.workflow}</Chip>
            <Chip>{run.autonomy}</Chip>
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
          <StageBar stages={run.stages} />
        </div>
        <div className={`driverbar ${run.driver}`} data-testid="driverbar">
          <strong>
            Driver:{" "}
            {run.driver === "human" ? `${run.attachedBy ?? "a person"}${attached ? " (you)" : ""}` : "agent"}
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
            <>
              <input
                aria-label="your name"
                placeholder="your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: 120 }}
              />
              <button
                type="button"
                className="primary"
                onClick={() => void attach()}
                disabled={run.driver === "human"}
              >
                Attach · a
              </button>
            </>
          )}
        </div>
        {note ? <div className="banner">{note}</div> : null}
        <div className="tabs">
          <button type="button" aria-pressed={tab === "terminal"} onClick={() => setTab("terminal")}>
            Terminal
          </button>
          <button type="button" aria-pressed={tab === "events"} onClick={() => setTab("events")}>
            Events · {events.length}
          </button>
          <span className="spacer" />
          <span className="dim">e editor · t events · d diff</span>
        </div>
        {tab === "terminal" ? (
          <>
            <div className="panes" role="tablist" aria-label="panes" data-testid="panes">
              {panes.map((p) => (
                <span key={p.id} className="pane-tab">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={shown === p.id}
                    onClick={() => setChosenPane(p.id)}
                    title={`${p.id} · ${p.state?.reason ?? ""}`}
                  >
                    {paneLabel(p)}
                  </button>
                  <Chip tone={stateTone(p.state?.state)}>
                    {p.state?.state ?? (p.live?.alive ? "live" : "off")}
                  </Chip>
                  {p.role !== "conductor" ? (
                    <button
                      type="button"
                      className="ghost"
                      title={`close ${p.id}`}
                      onClick={() => void closePane(p.id)}
                    >
                      ✕
                    </button>
                  ) : null}
                </span>
              ))}
              <span className="spacer" />
              <button type="button" onClick={() => void openShell()}>
                + Shell
              </button>
            </div>
            {shown && shown !== conductor?.id ? (
              <PaneTerminal key={shown} paneId={shown} repo={repo} canType={attached} />
            ) : (
              <RunTerminal runId={runId} repo={repo} canType={attached} onStatus={setTermStatus} />
            )}
          </>
        ) : (
          <div className="events">
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>type</th>
                  <th>source</th>
                  <th>what</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.at}-${String(i)}`}>
                    <td className="time">{clock(e.at)}</td>
                    <td className="type">{e.type}</td>
                    <td className="src">{e.origin ?? (e.agent ? `agent ${e.agent}` : "run")}</td>
                    <td>{e.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
              if (!attached && run.driver !== "human") void attach();
            }}
            onChange={(e) => setLine(e.target.value)}
          />
          <button type="submit" disabled={!attached}>
            Send
          </button>
        </form>
      </div>
      <aside className="side">
        <div className="box">
          <h3>Question</h3>
          {question ? (
            <QuestionBox run={run} onDone={refresh} />
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

/** The person's shell for a shell pane: theirs when the app knows it, `sh` otherwise. */
const shellOf = (): string => {
  try {
    return localStorage.getItem("metator.shell") || "sh";
  } catch {
    return "sh";
  }
};

function QuestionBox({ run, onDone }: { readonly run: Run; onDone(): void }) {
  const { client, me } = useDaemon();
  const q = run.questions[0];
  const [error, setError] = useState<string>();
  if (!q) return null;
  const answer = async (label: string) => {
    const r = await client.answer(q.runId, q.id, [label], me || "me", undefined, undefined, run.repo);
    setError(r.ok ? undefined : r.error?.message);
    if (r.ok) onDone();
  };
  return (
    <div>
      <div>{q.prompt}</div>
      <div className="chips" style={{ marginTop: 6 }}>
        {q.options.map((o) => (
          <button type="button" key={o.label} onClick={() => void answer(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
      {q.source === "permission" ? (
        <div className="dim" style={{ marginTop: 4 }}>
          Allow once · Always for this run · Make it a policy (`metator run answer --always`) · Deny
        </div>
      ) : null}
      {error ? <div className="banner">{error}</div> : null}
    </div>
  );
}
