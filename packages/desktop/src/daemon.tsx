/**
 * The live connection to the daemon (D7): the state and the inbox over their WebSockets, with a
 * fetch when a socket is down; the layout of every repository; the person's name, the repository
 * the list screens show and the daemon's address from local storage. `usePolled` (a request
 * repeated on an interval) lives here too; the hooks built on it are in `hooks.ts`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  DaemonClient,
  daemonUrl,
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
} from "./api.ts";
import { Modal } from "./components/modal.tsx";
import {
  autostart,
  flattenState,
  type Place,
  plansShown,
  type RepoSystemPlan,
  type Run,
  repoChoice,
  type SeenRuns,
  type StepPlace,
  sameRepo,
  seenFrom,
  seenKey,
  stepPlace,
  systemPlanOf,
  type Unreadable,
  withSeen,
  withTerminalAsks,
} from "./model.ts";
import { appShell } from "./shell.ts";
import { scratchCount, scratchRepos } from "./stage1.ts";
import { threadsStamp } from "./threads.ts";

export interface Daemon {
  readonly client: DaemonClient;
  readonly url: string;
  readonly connected: boolean;
  /** Nothing answers at the address (D3): the screens have nothing true to show. */
  readonly down: boolean;
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
  /** The app's shell can start the daemon itself (ADR-0087); false in a browser. */
  readonly startable: boolean;
  /** The folder the app starts the daemon for: the last one it was started for ("" when none). */
  readonly folder: string;
  readonly starting: boolean;
  /** Why the last start did not work. */
  readonly startError?: string;
  /** Starts (or finds) the daemon of a folder and points the app at it; remembers the folder. */
  start(folder: string): void;
  /** Tries the daemon again now, without waiting for the next attempt. */
  retry(): void;
  /** The person's name: the saved one, or asked for once in the app's own dialog ("" when they cancel). */
  who(): Promise<string>;
  /** Opens the name dialog to change the saved name. */
  changeName(): void;
}

const Ctx = createContext<Daemon | undefined>(undefined);

export const useDaemon = (): Daemon => {
  const d = useContext(Ctx);
  if (!d) throw new Error("useDaemon outside <DaemonProvider>");
  return d;
};

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a private window: nothing kept */
  }
};

/**
 * A request repeated on an interval (D11): the last good answer, the last failure, and a way to
 * ask again now. A new `key` (another run, another repository) starts over with nothing; `ms` 0
 * asks once. A failure keeps the data that was there: the screen says it is stale, not empty.
 */
export function usePolled<T>(
  key: string,
  fn: () => Promise<Envelope<T>>,
  ms: number,
): { readonly data: T | undefined; readonly error: string | undefined; reload(): Promise<void> } {
  const latest = useRef(fn);
  latest.current = fn;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key });
  const current = useRef(key);
  current.current = key;
  const reload = useCallback(async () => {
    const asked = current.current;
    const r = await latest.current();
    if (current.current !== asked) return;
    setState((s) =>
      r.ok && r.data !== undefined
        ? { key: asked, data: r.data }
        : {
            key: asked,
            ...(s.key === asked && s.data !== undefined ? { data: s.data } : {}),
            error: r.error?.message ?? "the daemon did not answer",
          },
    );
  }, []);
  useEffect(() => {
    // The key is what the effect is about: a new one asks again at once.
    void key;
    void reload();
    if (ms <= 0) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  }, [key, ms, reload]);
  const mine = state.key === key;
  return { data: mine ? state.data : undefined, error: mine ? state.error : undefined, reload };
}

/** A socket that is opened again after it drops, with a fetch meanwhile. */
function useStream<T>(
  url: string,
  path: string,
  attempt: number,
  fetchOnce: () => Promise<T | undefined>,
  onData: (d: T) => void,
) {
  const [up, setUp] = useState(false);
  const handler = useRef(onData);
  handler.current = onData;
  const fetcher = useRef(fetchOnce);
  fetcher.current = fetchOnce;
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

export function DaemonProvider({ children }: { readonly children: React.ReactNode }) {
  const [url, setUrlState] = useState(() => daemonUrl(window.location.search, read("metator.daemon")));
  const [me, setMeState] = useState(() => read("metator.me") ?? "");
  const client = useMemo(() => new DaemonClient(url), [url]);
  const [state, setState] = useState<StateData>();
  const [inbox, setInbox] = useState<readonly InboxItem[]>([]);
  const [paneAsks, setPaneAsks] = useState<readonly PaneAsk[]>([]);
  const [reviewCards, setReviewCards] = useState<readonly ReviewCardView[]>([]);
  const [error, setError] = useState<string>();
  const fetchState = useMemo(
    () => async () => {
      const r = await client.state();
      setError(r.ok ? undefined : r.error?.message);
      return r.ok ? r.data : undefined;
    },
    [client],
  );
  const fetchInbox = useMemo(
    () => async () => {
      const r = await client.inbox();
      return r.ok ? r.data : undefined;
    },
    [client],
  );
  const [attempt, setAttempt] = useState(0);
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
        setState(env.data);
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
        setInbox(env.data.decisions);
        setPaneAsks(env.data.panes ?? []);
        setReviewCards(env.data.reviews ?? []);
      }
    },
  );
  const { runs: stateRuns, repos, unreadable } = useMemo(() => flattenState(state), [state]);
  // The layout has no socket: it is read every second, for every repository the daemon serves.
  const names = repos.map((r) => r.name).join("\n");
  const layout = usePolled(
    `${url}\n${names}`,
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
  const [savedRepo, setSavedRepo] = useState(() => read("metator.repo"));
  const [seen, setSeen] = useState<SeenRuns>(() => seenFrom(read("metator.seen")));
  const markSeen = useCallback((run: { readonly runId: string; readonly repo?: string | undefined }) => {
    setSeen((before) => {
      const after = withSeen(before, seenKey(run), new Date().toISOString());
      write("metator.seen", JSON.stringify(after));
      return after;
    });
  }, []);
  // The name dialog: one question at a time; everyone who asked gets the same answer.
  const [asking, setAsking] = useState(false);
  const waiters = useRef<((name: string) => void)[]>([]);
  const meRef = useRef(me);
  meRef.current = me;
  const setMe = useCallback((name: string) => {
    write("metator.me", name);
    setMeState(name);
  }, []);
  const who = useCallback(
    () =>
      meRef.current
        ? Promise.resolve(meRef.current)
        : new Promise<string>((resolve) => {
            waiters.current.push(resolve);
            setAsking(true);
          }),
    [],
  );
  const settle = (name: string) => {
    if (name) setMe(name);
    setAsking(false);
    for (const w of waiters.current.splice(0)) w(name);
  };
  // Down: the socket is closed and the last request failed. A socket that only blinked is not down.
  const down = !stateUp && error !== undefined;
  const setUrl = useCallback((u: string) => {
    const clean = u.trim().replace(/\/+$/, "");
    write("metator.daemon", clean);
    setUrlState(clean);
    setError(undefined);
  }, []);
  // In the app's shell the daemon is started for the remembered folder, without a terminal.
  const shell = useMemo(() => appShell(), []);
  const [folder, setFolder] = useState(() => read("metator.folder") ?? "");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const tried = useRef<string | undefined>(undefined);
  const start = useCallback(
    (dir: string) => {
      const clean = dir.trim();
      if (!shell || clean === "") return;
      write("metator.folder", clean);
      setFolder(clean);
      tried.current = clean;
      setStarting(true);
      setStartError(undefined);
      shell
        .ensureDaemon(clean)
        .then(setUrl, (e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
        .finally(() => setStarting(false));
    },
    [shell, setUrl],
  );
  useEffect(() => {
    // A daemon that answered and then went away is started again, by itself.
    if (stateUp) tried.current = undefined;
    if (autostart({ shell: shell !== undefined, down, folder, tried: tried.current, starting }) === "start")
      start(folder);
  }, [shell, down, stateUp, folder, starting, start]);
  const repo = repoChoice(repos, savedRepo);
  const options = usePolled(`options:${url}:${repo ?? ""}`, () => client.options(repo), 3000);
  // The system plans that are not done, every few seconds: the sidebar counts a plan's steps from
  // them (a step not started yet still counts), and the Plan tab of a system run shows one.
  const plans = usePolled(
    `system-plans:${url}\n${names}`,
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
  const threadList = usePolled(
    `threads:${url}`,
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
  const value: Daemon = {
    client,
    url,
    connected: stateUp,
    down,
    ...(error ? { error } : {}),
    runs: shownRuns,
    repos,
    repo,
    run: (runId, ofRepo) =>
      runId === undefined
        ? undefined
        : shownRuns.find((r) => r.runId === runId && (ofRepo === undefined || sameRepo(r.repo, ofRepo))),
    panesOf: (ofRepo) => shownPanes.filter((p) => sameRepo(p.repo, ofRepo)),
    unreadable: down ? NO_UNREADABLE : unreadable,
    options: options.data?.options ?? NO_OPTIONS,
    optionsView: options.data,
    optionsError: options.error,
    reloadOptions: options.reload,
    systemPlans,
    planStepsOf: (r) => systemPlanOf(systemPlans, r, shownRuns)?.steps.length,
    stepPlaceOf: (runId) => stepPlace(systemPlans, runId),
    setRepo: (name) => {
      write("metator.repo", name);
      setSavedRepo(name);
    },
    scratchCount: (of) => (down ? 0 : scratchCount(state, of)),
    scratchRepos: (of) => (down ? [] : scratchRepos(state, of)),
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
    startable: shell !== undefined,
    folder,
    starting,
    ...(startError ? { startError } : {}),
    start,
    retry: () => setAttempt((n) => n + 1),
    who,
    changeName: () => setAsking(true),
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      {asking ? <NameDialog initial={me} onDone={settle} /> : null}
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
          <button type="button" onClick={() => onDone("")}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={name.trim() === ""}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
