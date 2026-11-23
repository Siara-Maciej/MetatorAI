/**
 * The repositories the app knows (round 20, ADR-0105): read from the shell's store
 * (`known_repos`), the one open marked, and the acts on them (add, open, remove from the app). In
 * a browser there is no store: `known` stays undefined and the top bar shows what the daemon serves.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { appCommands } from "./app-commands.ts";
import { useDaemon } from "./daemon.tsx";
import { afterRemove, currentRepo } from "./repos.ts";
import { type Commands, errorText, type KnownRepo } from "./tauri-commands.ts";

export interface Repos {
  /** The shell's commands: the Tauri window's, the e2e's fake, none in a browser. */
  readonly commands: Commands | undefined;
  /** The repositories and folders the app knows; undefined while they are read, and in a browser. */
  readonly known: readonly KnownRepo[] | undefined;
  /** The one the app has open. */
  readonly current: KnownRepo | undefined;
  /** Why the list could not be read. */
  readonly error: string | undefined;
  reload(): Promise<void>;
  /** Remembers a folder and opens it; resolves to why not, or undefined. */
  addAndOpen(path: string): Promise<string | undefined>;
  /** Starts the daemon of a known repository and shows it; resolves to why not, or undefined. */
  open(path: string): Promise<string | undefined>;
  /** Forgets a repository (its files stay); the open one is replaced by another, or the first run. */
  remove(path: string): Promise<string | undefined>;
}

const Ctx = createContext<Repos | undefined>(undefined);

export const useRepos = (): Repos => {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRepos outside <ReposProvider>");
  return r;
};

export function ReposProvider({ children }: { readonly children: React.ReactNode }) {
  const d = useDaemon();
  const commands = useMemo(() => appCommands(), []);
  const [known, setKnown] = useState<readonly KnownRepo[]>();
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    if (!commands) return;
    try {
      setKnown(await commands.knownRepos());
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
      setKnown((k) => k ?? []);
    }
  }, [commands]);
  const { folder, start, forgetFolder } = d;
  // The folder an older app remembered becomes the first known repository, once, when the app opens.
  const remembered = useRef(folder);
  useEffect(() => {
    if (!commands) return;
    void (async () => {
      const old = remembered.current;
      if (old !== "") {
        const list = await commands.knownRepos().catch(() => undefined);
        if (list && list.length === 0) await commands.addRepo(old).catch(() => undefined);
      }
      await reload();
    })();
  }, [commands, reload]);
  const current = known && folder !== "" ? known.find((k) => k.path === folder) : undefined;
  // Known repositories and none remembered as open when the app opens: the first is opened, once.
  const chose = useRef(false);
  useEffect(() => {
    if (!known || chose.current) return;
    chose.current = true;
    if (folder !== "") return;
    const first = currentRepo(known, undefined);
    if (first) void start(first.path);
  }, [known, folder, start]);
  const open = useCallback(
    async (path: string) => {
      const why = await start(path);
      if (why === undefined) window.location.hash = "#/inbox";
      return why;
    },
    [start],
  );
  const addAndOpen = useCallback(
    async (path: string) => {
      if (!commands) return "the app cannot add a repository in a browser";
      try {
        await commands.addRepo(path);
      } catch (e) {
        return errorText(e);
      }
      // The folder is remembered before the list grows: nothing else opens it a second time.
      const opened = open(path);
      await reload();
      return opened;
    },
    [commands, reload, open],
  );
  const remove = useCallback(
    async (path: string) => {
      if (!commands || !known) return "the app cannot remove a repository in a browser";
      try {
        await commands.removeRepo(path);
      } catch (e) {
        return errorText(e);
      }
      const next = afterRemove(known, path, current?.path);
      await reload();
      if (next.stay) return undefined;
      if (next.open) return open(next.open.path);
      forgetFolder();
      window.location.hash = "#/inbox";
      return undefined;
    },
    [commands, known, current, reload, open, forgetFolder],
  );
  const value: Repos = { commands, known, current, error, reload, addAndOpen, open, remove };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
