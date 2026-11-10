/**
 * The live connection to the daemon (D7): the state and the inbox over their WebSockets, with a
 * fetch when a socket is down; the person's name and the daemon's address from local storage.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  DaemonClient,
  daemonUrl,
  type InboxItem,
  type LayoutView,
  type PaneView,
  type RepoState,
  type StateData,
  wsUrl,
} from "./api.ts";
import type { Run } from "./model.ts";

export interface Daemon {
  readonly client: DaemonClient;
  readonly url: string;
  readonly connected: boolean;
  readonly error?: string;
  /** Every run of every repository, each with the repository it belongs to (a folder) or none. */
  readonly runs: readonly Run[];
  readonly repos: readonly { readonly name: string; readonly path: string }[];
  readonly inbox: readonly InboxItem[];
  /** Every pane of every repository's layout (R1, R4), each with the repository it belongs to. */
  readonly panes: readonly (PaneView & { readonly repo?: string | undefined })[];
  readonly me: string;
  setMe(name: string): void;
  setUrl(url: string): void;
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

/** A socket that is opened again after it drops, with a fetch meanwhile. */
function useStream<T>(
  url: string,
  path: string,
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
  }, [url, path]);
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
  const stateUp = useStream<{ ok: boolean; data?: StateData; error?: { message: string } }>(
    url,
    "/ws/state",
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
    async () => {
      const d = await fetchInbox();
      return d ? { ok: true, data: d } : undefined;
    },
    (env) => {
      if (env.ok && env.data) setInbox(env.data.decisions);
    },
  );
  const { runs, repos } = useMemo(() => flattenState(state), [state]);
  const [panes, setPanes] = useState<readonly (PaneView & { readonly repo?: string | undefined })[]>([]);
  // The layout has no socket: it is read every second, for every repository the daemon serves.
  useEffect(() => {
    let closed = false;
    const names = repos.length > 0 ? repos.map((r) => r.name) : [undefined];
    const tick = async () => {
      const all = await Promise.all(
        names.map(async (repo) => {
          const r = await client.layout(repo);
          return r.ok && r.data ? (r.data as LayoutView).panes.map((p) => ({ ...p, repo })) : [];
        }),
      );
      if (!closed) setPanes(all.flat());
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      closed = true;
      clearInterval(t);
    };
  }, [client, repos]);
  const value: Daemon = {
    client,
    url,
    connected: stateUp,
    ...(error ? { error } : {}),
    runs,
    repos,
    inbox,
    panes,
    me,
    setMe: (name) => {
      write("metator.me", name);
      setMeState(name);
    },
    setUrl: (u) => {
      const clean = u.replace(/\/+$/, "");
      write("metator.daemon", clean);
      setUrlState(clean);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
