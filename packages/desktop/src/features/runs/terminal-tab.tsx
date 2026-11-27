/**
 * The Terminal tab of a run: its live session, who types, its panes, the question and the links.
 *
 * The tab only lays its parts out (ADR-0113): what it keeps is the TerminalTab store
 * (`terminal-tab-state.ts`), the run is read from the daemon's store, and each part reads only the
 * value it draws: typing a line draws the composer, choosing a pane the pane tabs and the terminal.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { Chip } from "../../shared/components/chips.tsx";
import { CommandText, commandOf } from "../../shared/components/command-text.tsx";
import { type Daemon, useDaemonStore, usePolledSelect } from "../../shared/daemon/daemon.tsx";
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
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { useLatest } from "../../shared/use-latest.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { Tabs } from "../../ui/tabs.tsx";
import { QuickAnswer } from "../inbox/answer.tsx";
import { actionIn } from "../terminals/store-action.ts";
import { PaneTerminal, RunTerminal } from "../terminals/terminal.tsx";
import { portsText, runPhase, sessionOfferedAbove } from "./model.ts";
import { useRunControls } from "./run-controls.ts";
import { StartRun } from "./start-run.tsx";
import {
  attachedTo,
  linksKey,
  type PaneFacts,
  paneFacts,
  TerminalTab as TabStore,
  type TerminalTabState,
  useTabDaemon,
  useTabDaemonStore,
  useTerminalTab,
  useTerminalTabApi,
} from "./terminal-tab-state.ts";

interface RunRef {
  readonly runId: string;
  readonly repo: string | undefined;
}

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
  const daemon = useDaemonStore();
  const { runId, repo } = run;
  const view = useRef<HTMLDivElement>(null);
  return (
    <ScopeProvider
      key={`${repo ?? ""}:${runId}`}
      store={TabStore}
      init={{ daemon, runId, repo, pane: wantedPane }}
    >
      <Follow pane={wantedPane} />
      <RunKeys runId={runId} repo={repo} />
      <AnswerInPane runId={runId} repo={repo} answerIn={answerIn} onAnswering={onAnswering} view={view} />
      <div className="session">
        <div className="main">
          <DriverBar runId={runId} repo={repo} />
          <TabNotice />
          <AskBanner runId={runId} repo={repo} />
          <PaneTabs runId={runId} repo={repo} />
          <TermView runId={runId} repo={repo} view={view} />
          <Composer runId={runId} repo={repo} />
        </div>
        <aside className="side">
          <QuestionBox runId={runId} repo={repo} />
          <AppsBox runId={runId} repo={repo} />
          <ChangesBox runId={runId} repo={repo} onOpenChanges={onOpenChanges} />
          <LinksBox runId={runId} repo={repo} onOpenRun={onOpenRun} />
        </aside>
      </div>
    </ScopeProvider>
  );
}

/** The route's pane wins when the route changes; the run's session followed while the tab is open. */
function Follow({ pane }: { readonly pane: string | undefined }) {
  const api = useTerminalTabApi();
  useLayoutEffect(() => api.getState().routeTo(pane), [api, pane]);
  useEffect(() => api.getState().connect(), [api]);
  return null;
}

/** The run of the tab (the daemon's): a part draws again when it changed. */
const useTabRun = ({ runId, repo }: RunRef): Run | undefined => useTabDaemon((d) => d.run(runId, repo));

/** The person holds the run's keyboard, and whether anyone does. */
function useAttached({ runId, repo }: RunRef): { readonly attached: boolean; readonly taken: boolean } {
  const daemon = useTabDaemonStore();
  const attached = useStore(daemon, (d) => attachedTo(d.run(runId, repo), d.me));
  const taken = useStore(daemon, (d) => d.run(runId, repo)?.driver === "human");
  return { attached, taken };
}

/**
 * One fact of the run's panes and what the tab chose (`paneFacts`): the part draws again only when
 * the fact changed, whichever of the two stores changed (another pane chosen that the composer can
 * type to as well draws no composer again).
 */
function usePaneFact<K extends keyof PaneFacts>({ runId, repo }: RunRef, fact: K): PaneFacts[K] {
  const daemon = useTabDaemonStore();
  const tab = useTerminalTabApi();
  const of = (d: Daemon, s: TerminalTabState) =>
    paneFacts(panesOfRun(d.panesOf(repo), runId), s.chosen, s.opened)[fact];
  useTerminalTab((s) => of(daemon.getState(), s));
  return useStore(daemon, (d) => of(d, tab.getState()));
}

/** The run's panes, the conductor first (`panesOfRun`). */
function useRunPanes({ runId, repo }: RunRef) {
  const panesOf = useTabDaemon((d) => d.panesOf);
  return panesOfRun(panesOf(repo), runId);
}

/** a attaches, c releases, while the run is active and no dialog is open. */
function RunKeys(ref: RunRef) {
  const api = useTerminalTabApi();
  const daemon = useTabDaemonStore();
  const at = useLatest(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { runId, repo } = at.current;
      const d = daemon.getState();
      const run = d.run(runId, repo);
      if (!run || runPhase(run) !== "active" || document.querySelector("dialog[open]")) return;
      const s = api.getState();
      const attached = attachedTo(run, d.me);
      const { nothingLives } = paneFacts(panesOfRun(d.panesOf(repo), runId), s.chosen, s.opened);
      const k = plainKey(e);
      if (k === "a" && !attached && !nothingLives) void s.attach();
      if (k === "c" && attached) void s.release();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, daemon]);
  return null;
}

/** Answering in a pane: attach once, then focus the pane's terminal at its last line (the question). */
function AnswerInPane({
  answerIn,
  onAnswering,
  view,
  ...ref
}: RunRef & {
  readonly answerIn: { readonly pane?: string | undefined } | undefined;
  onAnswering: (() => void) | undefined;
  readonly view: React.RefObject<HTMLDivElement | null>;
}) {
  const api = useTerminalTabApi();
  const here = useTerminalTab((s) => s.here);
  const chosen = useTerminalTab((s) => s.chosen);
  // A new terminal handle draws this again, so the effect below runs once the pane is there.
  const ready = useTerminalTab((s) => s.ready);
  const { attached, taken } = useAttached(ref);
  const asked = useRef(false);
  const answering = answerIn ?? here;
  useEffect(() => {
    void ready;
    if (!answering) {
      asked.current = false;
      return;
    }
    const s = api.getState();
    if (answering.pane && answering.pane !== chosen) s.choose(answering.pane);
    if (!attached) {
      if (!asked.current && !taken) {
        asked.current = true;
        void s.attach();
      }
      return;
    }
    const handle = s.handle();
    if (!handle) return;
    handle.scrollToBottom();
    handle.focus();
    view.current?.scrollIntoView({ block: "end" });
    s.answered();
    onAnswering?.();
  });
  return null;
}

function DriverBar(ref: RunRef) {
  const run = useTabRun(ref);
  const { attached, taken } = useAttached(ref);
  const live = usePaneFact(ref, "live");
  const nothingLives = usePaneFact(ref, "nothingLives");
  const hasTerminal = useTerminalTab((s) => s.opened);
  const api = useTerminalTabApi();
  if (!run || runPhase(run) !== "active") return null;
  return (
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
        <Button onClick={() => void api.getState().release()}>Release to agent · c</Button>
      ) : (
        <Button
          variant="primary"
          onClick={() => void api.getState().attach()}
          disabled={taken || nothingLives}
          title={nothingLives ? "No terminal to type into: open a session first" : undefined}
        >
          Attach · a
        </Button>
      )}
    </div>
  );
}

function TabNotice() {
  const notice = useTerminalTab((s) => s.notice);
  const closeNotice = useTerminalTab((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

function AskBanner(ref: RunRef) {
  const ask = useStore(useTabDaemonStore(), (d) => d.run(ref.runId, ref.repo)?.terminalAsk);
  const { attached } = useAttached(ref);
  const shown = usePaneFact(ref, "shown");
  const choose = useTerminalTab((s) => s.choose);
  if (!ask) return null;
  return (
    <div className="banner ask-banner" data-testid="terminal-ask">
      <span className="msg">
        The agent asks in its terminal{attached ? ": type your answer there." : ". Attach to answer."}
      </span>
      {ask !== shown ? <Button onClick={() => choose(ask)}>Show the pane</Button> : null}
    </div>
  );
}

export function PaneTabs(ref: RunRef) {
  const panes = useRunPanes(ref);
  const shown = usePaneFact(ref, "shown");
  const status = useTerminalTab((s) => s.status);
  const api = useTerminalTabApi();
  return (
    <Tabs
      label="panes"
      className="panes"
      testId="panes"
      current={shown}
      onSelect={(id) => api.getState().choose(id)}
      items={panes.map((p) => ({
        id: p.id,
        label: paneLabel(p),
        title: `${p.id} · ${p.state?.reason ?? ""}`,
        after: (
          <>
            <Chip tone={lookOf("pane", paneStateOf(p)).tone}>{paneStateOf(p)}</Chip>
            {p.role !== "conductor" ? (
              <Button
                variant="ghost"
                title={`close ${p.id}`}
                aria-label={`close ${p.id}`}
                onClick={() => void api.getState().close(p.id)}
              >
                ✕
              </Button>
            ) : null}
          </>
        ),
      }))}
    >
      {status.alive === false && status.exitCode !== undefined ? (
        <Chip tone="amber">session exited {status.exitCode}</Chip>
      ) : null}
      <span className="spacer" />
      <Button onClick={() => void api.getState().openShell()}>+ Shell</Button>
    </Tabs>
  );
}

/** The pane chosen, else the run's own terminal once it is shown, else why there is none. */
function TermView({ view, ...ref }: RunRef & { readonly view: React.RefObject<HTMLDivElement | null> }) {
  const shown = usePaneFact(ref, "shown");
  const conductor = usePaneFact(ref, "conductor");
  const hasTerminal = useTerminalTab((s) => s.opened);
  const { attached } = useAttached(ref);
  const api = useTerminalTabApi();
  const ready = (h: Parameters<TerminalTabState["setHandle"]>[0]) => api.getState().setHandle(h);
  if (shown && shown !== conductor)
    return (
      <div ref={view} className="term-view">
        <PaneTerminal key={shown} paneId={shown} repo={ref.repo} canType={attached} onReady={ready} />
      </div>
    );
  if (hasTerminal)
    return (
      <div ref={view} className="term-view">
        <RunTerminal
          runId={ref.runId}
          repo={ref.repo}
          canType={attached}
          onStatus={(s) => api.getState().setStatus(s)}
          onReady={ready}
        />
      </div>
    );
  return <NoSession {...ref} />;
}

function NoSession(ref: RunRef) {
  const run = useTabRun(ref);
  const panesOf = useTabDaemon((d) => d.panesOf);
  const busy = useTerminalTab((s) => s.busy);
  const api = useTerminalTabApi();
  const daemon = useTabDaemonStore();
  if (!run) return null;
  const phase = runPhase(run);
  const offeredAbove = sessionOfferedAbove(run, panesOf(ref.repo));
  const action = actionIn(api, daemon, busy, () => api.getState().reloadLinks());
  return (
    <div className="empty no-session" data-testid="no-session">
      <h2>No session runs for this run</h2>
      <p>
        {phase === "active"
          ? run.driving
            ? "An agent works on it in the background, without a terminal. Opening a session starts the host in a terminal of its own."
            : offeredAbove
              ? "Nothing works on it. Open a session in the bar above to start the host in a terminal."
              : "Nothing works on it. Opening a session starts the host in a terminal."
          : phase === "escalated"
            ? "The run stopped. Resume it above; its events say what happened."
            : "The run is finished. Its events and its changes are what is left."}
      </p>
      {phase !== "active" ? (
        <a href={routeHash({ screen: "run", runId: ref.runId, tab: "activity" })}>Activity</a>
      ) : offeredAbove ? null : (
        <StartRun run={run} action={action} compact sessionOnly />
      )}
    </div>
  );
}

/** The line typed to the session: typing draws only this. */
export function Composer(ref: RunRef) {
  const active = useStore(useTabDaemonStore(), (d) => {
    const run = d.run(ref.runId, ref.repo);
    return run !== undefined && runPhase(run) === "active";
  });
  const line = useTerminalTab((s) => s.line);
  const noTerminal = usePaneFact(ref, "noTerminal");
  const { attached, taken } = useAttached(ref);
  const api = useTerminalTabApi();
  if (!active) return null;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void api.getState().send();
      }}
    >
      <input
        aria-label="message to the session"
        disabled={noTerminal}
        placeholder={
          noTerminal
            ? "no terminal yet: open a session first"
            : attached
              ? "type to the session · y / a / p / n are shortcuts the host knows"
              : "attach to type (click here attaches)"
        }
        value={line}
        onFocus={() => {
          if (!attached && !taken) void api.getState().attach();
        }}
        onChange={(e) => api.getState().type(e.target.value)}
      />
      <Button type="submit" disabled={!attached || noTerminal}>
        Send
      </Button>
    </form>
  );
}

function QuestionBox(ref: RunRef) {
  const run = useTabRun(ref);
  const api = useTerminalTabApi();
  const daemon = useTabDaemonStore();
  if (!run) return null;
  const phase = runPhase(run);
  const question = run.questions[0];
  const host = question?.source === "permission" ? hostPromptOf(question.prompt) : undefined;
  return (
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
            repo={ref.repo}
            onDone={(choices) => {
              if (goesToPane(question, choices[0]))
                api
                  .getState()
                  .answerHere(
                    paneOfQuestion(question, panesOfRun(daemon.getState().panesOf(ref.repo), ref.runId)),
                  );
              void api.getState().reloadLinks();
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
  );
}

function AppsBox(ref: RunRef) {
  const run = useTabRun(ref);
  const services = run?.services ?? [];
  return (
    <div className="box">
      <h3>Apps</h3>
      {services.length === 0 ? <div className="muted">no services for this worktree</div> : null}
      {services.map((s) => (
        <div className="svc" key={s.service}>
          <span>{s.service}</span>
          <span className="dim">
            {s.status} · {portsText(s.ports)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChangesBox({ onOpenChanges, ...ref }: RunRef & { onOpenChanges(runId: string): void }) {
  const run = useTabRun(ref);
  const api = useTerminalTabApi();
  const daemon = useTabDaemonStore();
  const { openEditor } = useRunControls(
    run,
    actionIn(api, daemon, false, () => api.getState().reloadLinks()),
  );
  if (!run) return null;
  return (
    <div className="box">
      <h3>Changes</h3>
      <div className="row">
        <Button variant="ghost" onClick={() => onOpenChanges(ref.runId)}>
          Open changes
        </Button>
        <Button variant="ghost" onClick={() => void openEditor()}>
          Open in editor
        </Button>
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
  );
}

const NO_LINKS = { messages: [], conflicts: [] } as const;

function LinksBox({ onOpenRun, ...ref }: RunRef & { onOpenRun(runId: string): void }) {
  const { runId, repo } = ref;
  const run = useTabRun(ref);
  const client = useTabDaemon((d) => d.client);
  const links = usePolledSelect(
    linksKey(runId, repo),
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
    (d) => d ?? NO_LINKS,
  );
  const { messages, conflicts } = links;
  if (!run) return null;
  return (
    <div className={`box${conflicts.length > 0 ? " warn" : ""}`}>
      <h3>Links</h3>
      {run.parent ? (
        <div>
          parent{" "}
          <Button variant="ghost" className="mono" onClick={() => onOpenRun(run.parent as string)}>
            {run.parent}
          </Button>
        </div>
      ) : null}
      {run.children?.map((c) => (
        <div key={c}>
          step{" "}
          <Button variant="ghost" className="mono" onClick={() => onOpenRun(c)}>
            {c}
          </Button>
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
  );
}
