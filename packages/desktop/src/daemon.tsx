/**
 * The live connection to the daemon (D7): the state and the inbox over their WebSockets, with a
 * fetch when a socket is down; the layout of every repository; the person's name, the repository
 * the list screens show and the daemon's address from local storage. Two hooks every screen
 * shares live here too: `usePolled` (a request repeated on an interval) and `useWho` (the one
 * place the person's name is asked for).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  DaemonClient,
  daemonUrl,
  type Envelope,
  type InboxItem,
  type PaneView,
  type RepoState,
  type StateData,
  type WorkspaceView,
  wsUrl,
} from "./api.ts";
import { type Run, repoChoice, withTerminalAsks } from "./model.ts";

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
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  /** The repository the list screens show when the daemon serves a folder (D10); none otherwise. */
  readonly repo: string | undefined;
  setRepo(name: string): void;
  readonly inbox: readonly InboxItem[];
  /** Every pane of every repository's layout (R1, R4), each with the repository it belongs to. */
  readonly panes: readonly (PaneView & { readonly repo?: string | undefined })[];
  /** Every workspace of every repository's layout, read with the panes. */
  readonly workspaces: readonly (WorkspaceView & { readonly repo?: string | undefined })[];
  readonly me: string;
  setMe(name: string): void;
  setUrl(url: string): void;
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

/** The runs of a `/state` answer, flattened across a folder's repositories. */
export function flattenState(data: StateData | undefined): {
  runs: Run[];
  repos: { name: string; path: string }[];
} {
  if (!data) return { runs: [], repos: [] };
  if ("repos" in data) {
    const repos = (data.repos as readonly RepoState[]).map((r) => ({ name: r.name, path: r.path }));
    const runs = (data.repos as readonly RepoState[]).flatMap((r) =>
      (r.runs ?? []).map((run) => ({ ...run, repo: r.name })),
    );
    return { runs, repos };
  }
  return { runs: [...data.runs], repos: [] };
}

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

/** The person's name and the one way it is asked for (D11): the app's dialog, once. */
export const useWho = (): { readonly me: string; who(): Promise<string> } => {
  const { me, who } = useDaemon();
  return { me, who };
};

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
  useStream<{ ok: boolean; data?: { decisions: InboxItem[] } }>(
    url,
    "/ws/inbox",
    attempt,
    async () => {
      const d = await fetchInbox();
      return d ? { ok: true, data: d } : undefined;
    },
    (env) => {
      if (env.ok && env.data) setInbox(env.data.decisions);
    },
  );
  const { runs: stateRuns, repos } = useMemo(() => flattenState(state), [state]);
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
  const value: Daemon = {
    client,
    url,
    connected: stateUp,
    down,
    ...(error ? { error } : {}),
    runs: down ? NO_RUNS : runs,
    repos,
    repo: repoChoice(repos, savedRepo),
    setRepo: (name) => {
      write("metator.repo", name);
      setSavedRepo(name);
    },
    inbox: down ? NO_INBOX : inbox,
    panes: down ? NO_PANES : panes,
    workspaces: down ? NO_WORKSPACES : workspaces,
    me,
    setMe,
    setUrl: (u) => {
      const clean = u.trim().replace(/\/+$/, "");
      write("metator.daemon", clean);
      setUrlState(clean);
      setError(undefined);
    },
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
const NO_PANES: Daemon["panes"] = [];
const NO_WORKSPACES: Daemon["workspaces"] = [];

/** The one place the app asks who the person is: their name goes next to every answer they give. */
function NameDialog({ initial, onDone }: { readonly initial: string; onDone(name: string): void }) {
  const [name, setName] = useState(initial);
  return (
    <div className="backdrop">
      <form
        className="dialog name-dialog"
        role="dialog"
        aria-label="your name"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onDone(name.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone("");
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
    </div>
  );
}
