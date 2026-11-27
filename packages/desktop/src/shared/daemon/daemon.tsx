/**
 * The live connection to the daemon (D7): the state and the inbox over their WebSockets, with a
 * fetch when a socket is down; the layout of every repository; the person's name, the repository
 * the list screens show and the daemon's address from local storage. `usePolled` (a request
 * repeated on an interval) lives here too; the hooks built on it are in `hooks.ts`.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import {
  DaemonClient,
  type Envelope,
  type InboxData,
  type InboxItem,
  type OptionsView,
  type PaneAsk,
  type PaneView,
  type ResolvedOption,
  type ReviewCardView,
  type StateData,
  type ThreadView,
  type WorkspaceView,
  wsUrl,
} from "../api/api.ts";
import {
  type Polled,
  queryClient,
  readPolledAgain,
  shared,
  usePolledAt,
  usePolledSelectAt,
} from "../api/query.ts";
import { flattenState, type Place, repoChoice, sameRepo, type Unreadable } from "../model/places.ts";
import { type Run, withTerminalAsks } from "../model/runs.ts";
import type { SeenRuns } from "../model/session.ts";
import { scratchCount, scratchRepos } from "../model/stage1.ts";
import {
  plansShown,
  type RepoSystemPlan,
  type StepPlace,
  stepPlace,
  systemPlanOf,
} from "../model/system-plans.ts";
import { threadsStamp } from "../model/threads.ts";
import { useLatest } from "../use-latest.ts";
import { createStateStore, publish, type Store, useFields } from "./daemon-store.ts";
import { useDaemonEvents } from "./events.ts";
import { usePulse } from "./heartbeat.ts";
import {
  changeName,
  daemonAnswered,
  forgetFolder,
  markSeen,
  type Session,
  sessionShell,
  sessionStore,
  setMe,
  setRepo,
  settleName,
  setUrl,
  start,
  who,
} from "./session.ts";

export interface Daemon {
  readonly client: DaemonClient;
  readonly url: string;
  readonly connected: boolean;
  /** Nothing answers at the address (D3): the screens have nothing true to show. */
  readonly down: boolean;
  /**
   * The daemon answers its pulse (`heartbeat.ts`). False while it holds the connection but says
   * nothing (stopped, stuck): what the screens show is from before `silentSince`.
   */
  readonly answering: boolean;
  /** When the daemon last answered, while it does not. */
  readonly silentSince?: number;
  readonly error?: string;
  /**
   * Every run of every repository, each with the repository it belongs to (a folder) or none; a
   * run whose agent asks in its terminal counts as waiting for you (D2).
   */
  readonly runs: readonly Run[];
  /** The places a folder's daemon serves: each repository's checkout, a worktree with `worktreeOf`. */
  readonly repos: readonly Place[];
  /** The repository the list screens show when the daemon serves a folder (D10); none otherwise. */
  readonly repo: string | undefined;
  setRepo(name: string): void;
  readonly inbox: readonly InboxItem[];
  /** The questions of panes without a run (the intake chat), from `/inbox`'s `panes` (ADR-0091). */
  readonly paneAsks: readonly PaneAsk[];
  /** The reviews' cards (round 18), from `/inbox`'s `reviews`: composed by the daemon. */
  readonly reviewCards: readonly ReviewCardView[];
  /**
   * How many debug changes the daemon's state counts (round 13), in all repositories or the ones
   * named; 0 on a daemon that does not count them (then nothing asks for `/scratch`).
   */
  scratchCount(repos?: readonly (string | undefined)[]): number;
  /** The repositories that have debug changes, of all or of the ones named. */
  scratchRepos(repos?: readonly (string | undefined)[]): (string | undefined)[];
  /** Every pane of every repository's layout (R1, R4), each with the repository it belongs to. */
  readonly panes: readonly (PaneView & { readonly repo?: string | undefined })[];
  /**
   * The threads (round 16): one topic each, with its chat terminal and the runs started in it.
   * None from a daemon that has no threads (then every task is "Without a chat").
   */
  readonly threads: readonly ThreadView[];
  /** Reads the threads again now (after a new chat, a close or a reopen). */
  reloadThreads(): Promise<void>;
  /** Every workspace of every repository's layout, read with the panes. */
  readonly workspaces: readonly (WorkspaceView & { readonly repo?: string | undefined })[];
  /** The run with this id; in a folder, the one of `repo` when it is given. */
  run(runId: string | undefined, repo?: string): Run | undefined;
  /** The panes of one repository: in a folder two repositories may use the same pane ids. */
  panesOf(repo: string | undefined): readonly (PaneView & { readonly repo?: string | undefined })[];
  /** Runs whose record cannot be read: they are in no list, so the panel says where they are. */
  readonly unreadable: readonly Unreadable[];
  /**
   * The options of the shown repository (S1), read once for the whole app every few seconds:
   * the settings screen, the workbench's keys and look, and the notifications all read these.
   */
  readonly options: readonly ResolvedOption[];
  readonly optionsView: OptionsView | undefined;
  readonly optionsError: string | undefined;
  reloadOptions(): Promise<void>;
  /** The system plans of every repository that are not done, with their steps and child runs. */
  readonly systemPlans: readonly RepoSystemPlan[];
  /** How many steps the system plan a run is the parent of has, when the app knows the plan. */
  planStepsOf(run: Run): number | undefined;
  /** The place of a run's step in the system plan that started it (wave order), when it is one. */
  stepPlaceOf(runId: string): StepPlace | undefined;
  /** When this person last opened each run (per window): a finished run reads `done` until they look. */
  readonly seen: SeenRuns;
  /** The run was opened now. */
  markSeen(run: { readonly runId: string; readonly repo?: string | undefined }): void;
  readonly me: string;
  setMe(name: string): void;
  setUrl(url: string): void;
  /** The app's shell can start the daemon itself (ADR-0101); false in a browser. */
  readonly startable: boolean;
  /** The folder the app starts the daemon for: the last one it was started for ("" when none). */
  readonly folder: string;
  readonly starting: boolean;
  /** Why the last start did not work. */
  readonly startError?: string;
  /**
   * Starts (or finds) the daemon of a folder and points the app at it; remembers the folder.
   * Resolves to why it did not start, or undefined when it did.
   */
  start(folder: string): Promise<string | undefined>;
  /** Forgets the remembered folder (it was removed from the app): nothing is started for it again. */
  forgetFolder(): void;
  /** Tries the daemon again now, without waiting for the next attempt. */
  retry(): void;
  /** The person's name: the saved one, or asked for once in the app's own dialog ("" when they cancel). */
  who(): Promise<string>;
  /** Opens the name dialog to change the saved name. */
  changeName(): void;
}

const Ctx = createContext<Store<Daemon> | undefined>(undefined);

/**
 * The fields of the daemon's state this part of the app reads: it draws again only when one of
 * them changed. Name what is used, nothing more.
 */
export function useDaemon<K extends keyof Daemon>(...keys: readonly [K, ...K[]]): Pick<Daemon, K> {
  return useFields(useDaemonStore(), keys);
}

/** The daemon's state to read when an act needs it (a click), without drawing again on its changes. */
export function useDaemonStore(): Store<Daemon> {
  const store = useContext(Ctx);
  if (!store) throw new Error("useDaemon outside <DaemonProvider>");
  return store;
}

/** One run (of `repo` in a folder): draws again only when that run changed. */
export function useRun(runId: string | undefined, repo?: string): Run | undefined {
  return useStore(useDaemonStore(), (d) => d.run(runId, repo));
}

/**
 * A request repeated on an interval (D11): the last good answer, the last failure, and a way to
 * ask again now. A new `key` (another run, another repository) starts over with what the app last
 * read for it, or nothing; `ms` 0 asks once; `enabled` false asks nothing. A failure keeps the
 * data that was there: the screen says it is stale (`<Freshness>`), not empty. An answer equal to
 * the last one draws nothing again.
 */
export function usePolled<T>(
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
  enabled = true,
): Polled<T> {
  const { url } = useDaemon("url");
  return usePolledAt(url, key, fn, ms, enabled);
}

/**
 * One part of a polled answer (ADR-0113): the part draws again only when what `select` takes from
 * the answer changed. Parts with the same `key` share one request; `select` gets `undefined` before
 * the first answer.
 */
export function usePolledSelect<T, R>(
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
  select: (data: T | undefined) => R,
): R {
  const { url } = useDaemon("url");
  return usePolledSelectAt(url, key, fn, ms, select);
}

/** Reads a polled request of this window's daemon again now: an action's answer changed it. */
export const readAgainNow = (url: string, key: string): Promise<void> =>
  readPolledAgain(queryClient, url, key);

/** A socket that is opened again after it drops, with a fetch meanwhile. */
function useStream<T>(
  url: string,
  path: string,
  attempt: number,
  fetchOnce: () => Promise<T | undefined>,
  onData: (d: T) => void,
) {
  const [up, setUp] = useState(false);
  const handler = useLatest(onData);
  const fetcher = useLatest(fetchOnce);
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void attempt;
    const poll = async () => {
      const d = await fetcher.current();
      if (!closed && d !== undefined) handler.current(d);
    };
    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl(url, path));
      } catch {
        timer = setTimeout(open, 2000);
        return;
      }
      ws.onopen = () => setUp(true);
      ws.onmessage = (m) => handler.current(JSON.parse(String(m.data)) as T);
      ws.onclose = () => {
        setUp(false);
        void poll();
        timer = setTimeout(open, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    void poll();
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
    // The socket is the URL's: the fetch and the handler are read through refs, never re-open it.
    // A new attempt (Retry) opens it again now.
  }, [url, path, attempt]);
  return up;
}

export const DaemonProvider = ({ children }: { readonly children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <DaemonState>{children}</DaemonState>
  </QueryClientProvider>
);

function DaemonState({ children }: { readonly children: React.ReactNode }) {
  const { url, me, asking, savedRepo, seen, folder, starting, startError } = useStore(
    sessionStore(),
    useShallow((s: Session) => s),
  );
  const client = useMemo(() => new DaemonClient(url), [url]);
  const [state, setState] = useState<StateData>();
  const [inbox, setInbox] = useState<readonly InboxItem[]>([]);
  const [paneAsks, setPaneAsks] = useState<readonly PaneAsk[]>([]);
  const [reviewCards, setReviewCards] = useState<readonly ReviewCardView[]>([]);
  // What the daemon at this address last refused: another address starts with nothing.
  const [failure, setFailure] = useState<{ readonly url: string; readonly message: string }>();
  const error = failure?.url === url ? failure.message : undefined;
  const setError = (message: string | undefined) =>
    setFailure(message === undefined ? undefined : { url, message });
  // Read through the sockets' latest handlers: a new client never re-opens a socket by itself.
  const fetchState = async () => {
    const r = await client.state();
    setError(r.ok ? undefined : r.error?.message);
    return r.ok ? r.data : undefined;
  };
  const fetchInbox = async () => {
    const r = await client.inbox();
    return r.ok ? r.data : undefined;
  };
  const [attempt, setAttempt] = useState(0);
  // The daemon says which topics changed: their queries are read again, polling is the fallback.
  useDaemonEvents(url);
  const stateUp = useStream<{ ok: boolean; data?: StateData; error?: { message: string } }>(
    url,
    "/ws/state",
    attempt,
    async () => {
      const d = await fetchState();
      return d ? { ok: true, data: d } : undefined;
    },
    (env) => {
      if (env.ok && env.data) {
        const next = env.data;
        setState((before) => shared(before, next));
        setError(undefined);
      } else if (env.error) setError(env.error.message);
    },
  );
  useStream<{ ok: boolean; data?: InboxData }>(
    url,
    "/ws/inbox",
    attempt,
    async () => {
      const d = await fetchInbox();
      return d ? { ok: true, data: d } : undefined;
    },
    (env) => {
      if (env.ok && env.data) {
        const next = env.data;
        setInbox((before) => shared(before, next.decisions));
        setPaneAsks((before) => shared(before, next.panes ?? NO_PANE_ASKS));
        setReviewCards((before) => shared(before, next.reviews ?? NO_REVIEW_CARDS));
      }
    },
  );
  const { runs: stateRuns, repos, unreadable } = useMemo(() => flattenState(state), [state]);
  // The layout has no socket: it is read every second, for every repository the daemon serves.
  const names = repos.map((r) => r.name).join("\n");
  const layout = usePolledAt(
    url,
    `layout:${names}`,
    async () => {
      const all = await Promise.all(
        (repos.length > 0 ? repos.map((r) => r.name) : [undefined]).map(async (repo) => {
          const r = await client.layout(repo);
          return r.ok && r.data
            ? {
                panes: r.data.panes.map((p) => ({ ...p, repo })),
                workspaces: r.data.workspaces.map((w) => ({ ...w, repo })),
              }
            : undefined;
        }),
      );
      const got = all.filter((x) => x !== undefined);
      return got.length > 0
        ? {
            ok: true,
            data: { panes: got.flatMap((x) => x.panes), workspaces: got.flatMap((x) => x.workspaces) },
          }
        : { ok: false, error: { code: "UNREACHABLE", message: "no layout" } };
    },
    1000,
  );
  const panes = layout.data?.panes ?? NO_PANES;
  const workspaces = layout.data?.workspaces ?? NO_WORKSPACES;
  const runs = useMemo(() => withTerminalAsks(stateRuns, panes), [stateRuns, panes]);
  // Down: the socket is closed and the last request failed. A socket that only blinked is not down.
  const down = !stateUp && error !== undefined;
  // A socket stays open while the daemon is stopped or stuck: its pulse says whether it answers.
  const pulse = usePulse(client);
  // In the app's shell the daemon is started for the remembered folder, without a terminal.
  useEffect(() => {
    void folder;
    void starting;
    daemonAnswered(stateUp, down);
  }, [stateUp, down, folder, starting]);
  const repo = repoChoice(repos, savedRepo);
  const options = usePolledAt(url, `options:${repo ?? ""}`, () => client.options(repo), 3000);
  // The system plans that are not done, every few seconds: the sidebar counts a plan's steps from
  // them (a step not started yet still counts), and the Plan tab of a system run shows one.
  const plans = usePolledAt(
    url,
    `system-plans:${names}`,
    async () => {
      const all = await Promise.all(
        (repos.length > 0 ? repos.map((r) => r.name) : [undefined]).map(async (name) => {
          const list = await client.systemPlans(name);
          if (!list.ok || !Array.isArray(list.data)) return [];
          // Open plans, and the ones finished in the last day (the graph keeps them, dimmed).
          const open = plansShown(list.data, Date.now());
          const views = await Promise.all(open.map((p) => client.systemPlan(p.id, name)));
          return views.flatMap((v, i) =>
            v.ok && v.data ? [{ ...v.data, repo: name, updatedAt: open[i]?.updatedAt ?? null }] : [],
          );
        }),
      );
      return { ok: true, data: all.flat() };
    },
    5000,
  );
  const systemPlans = plans.data ?? NO_PLANS;
  // The threads: read again whenever the state says one changed (`threads.updatedAt`), and every
  // two seconds for their tasks' states and a new chat pane.
  const threadList = usePolledAt(
    url,
    "threads",
    async () => {
      const r = await client.threads();
      return r.ok && r.data
        ? { ok: true, data: [...(r.data.threads ?? []), ...(r.data.closed ?? [])] }
        : { ok: false, ...(r.error ? { error: r.error } : {}) };
    },
    2000,
  );
  const stamp = threadsStamp(state);
  const reloadThreadList = threadList.reload;
  useEffect(() => {
    // A new stamp is what the effect is about: the threads are read again at once.
    void stamp;
    void reloadThreadList();
  }, [stamp, reloadThreadList]);
  const shownRuns = down ? NO_RUNS : runs;
  const shownPanes = down ? NO_PANES : panes;
  // What reads the state is given the same function until what it reads from changes.
  const run = useCallback<Daemon["run"]>(
    (runId, ofRepo) =>
      runId === undefined
        ? undefined
        : shownRuns.find((r) => r.runId === runId && (ofRepo === undefined || sameRepo(r.repo, ofRepo))),
    [shownRuns],
  );
  const panesOf = useCallback<Daemon["panesOf"]>(
    (ofRepo) => shownPanes.filter((p) => sameRepo(p.repo, ofRepo)),
    [shownPanes],
  );
  const planStepsOf = useCallback<Daemon["planStepsOf"]>(
    (r) => systemPlanOf(systemPlans, r, shownRuns)?.steps.length,
    [systemPlans, shownRuns],
  );
  const stepPlaceOf = useCallback<Daemon["stepPlaceOf"]>(
    (runId) => stepPlace(systemPlans, runId),
    [systemPlans],
  );
  const countScratch = useCallback<Daemon["scratchCount"]>(
    (of) => (down ? 0 : scratchCount(state, of)),
    [down, state],
  );
  const reposWithScratch = useCallback<Daemon["scratchRepos"]>(
    (of) => (down ? [] : scratchRepos(state, of)),
    [down, state],
  );
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const value: Daemon = {
    client,
    url,
    connected: stateUp,
    down,
    answering: pulse.answering,
    ...(pulse.silentSince !== undefined ? { silentSince: pulse.silentSince } : {}),
    ...(error ? { error } : {}),
    runs: shownRuns,
    repos,
    repo,
    run,
    panesOf,
    unreadable: down ? NO_UNREADABLE : unreadable,
    options: options.data?.options ?? NO_OPTIONS,
    optionsView: options.data,
    optionsError: options.error,
    reloadOptions: options.reload,
    systemPlans,
    planStepsOf,
    stepPlaceOf,
    setRepo,
    scratchCount: countScratch,
    scratchRepos: reposWithScratch,
    inbox: down ? NO_INBOX : inbox,
    paneAsks: down ? NO_PANE_ASKS : paneAsks,
    reviewCards: down ? NO_REVIEW_CARDS : reviewCards,
    panes: shownPanes,
    workspaces: down ? NO_WORKSPACES : workspaces,
    threads: down ? NO_THREADS : (threadList.data ?? NO_THREADS),
    reloadThreads: threadList.reload,
    seen,
    markSeen,
    me,
    setMe,
    setUrl,
    startable: sessionShell() !== undefined,
    folder,
    starting,
    ...(startError ? { startError } : {}),
    start,
    forgetFolder,
    retry,
    changeName,
    who,
  };
  // The store holds what this render made; whoever reads a field hears only of that field's change.
  const [store] = useState(() => createStateStore(value));
  useLayoutEffect(() => publish(store, value));
  return (
    <Ctx.Provider value={store}>
      {children}
      {asking ? <NameDialog initial={me} onDone={settleName} /> : null}
    </Ctx.Provider>
  );
}

const NO_RUNS: readonly Run[] = [];
const NO_INBOX: readonly InboxItem[] = [];
const NO_REVIEW_CARDS: readonly ReviewCardView[] = [];
const NO_PANE_ASKS: readonly PaneAsk[] = [];
const NO_PANES: Daemon["panes"] = [];
const NO_WORKSPACES: Daemon["workspaces"] = [];
const NO_UNREADABLE: readonly Unreadable[] = [];
const NO_OPTIONS: readonly ResolvedOption[] = [];
const NO_PLANS: readonly RepoSystemPlan[] = [];
const NO_THREADS: readonly ThreadView[] = [];

/** The one place the app asks who the person is: their name goes next to every answer they give. */
function NameDialog({ initial, onDone }: { readonly initial: string; onDone(name: string): void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal label="your name" className="dialog name-dialog" onClose={() => onDone("")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onDone(name.trim());
        }}
      >
        <h2>Who are you?</h2>
        <p className="muted">
          Your name is written next to every answer, approval and note you give from this app. It is kept in
          this window; change it any time from the top bar.
        </p>
        <label className="field">
          <span>Your name</span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens because an action needs the name
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="for example: alice"
          />
        </label>
        <div className="foot">
          <span className="spacer" />
          <Button onClick={() => onDone("")}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={name.trim() === ""}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
