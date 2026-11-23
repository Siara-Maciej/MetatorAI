/**
 * The repositories the app knows (round 20, ADR-0105): read from the shell's store
 * (`known_repos`), the one open marked, and the acts on them (add, open, remove from the app). In
 * a browser there is no store: `known` stays undefined and the top bar shows what the daemon serves.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { appCommands } from "./app-commands.ts";
import { useDaemon } from "./daemon.tsx";
import { editorChoice, type HostEditor, statesOf } from "./devcontainers.ts";
import { afterRemove, type ContainerStates, currentRepo } from "./repos.ts";
import { type Commands, type DevContainerList, errorText, type KnownRepo } from "./tauri-commands.ts";

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
  /**
   * The dev containers the engine listed last (round 21), read when the app knows one and again
   * on `refreshContainers`; undefined before, and in a browser.
   */
  readonly containers: DevContainerList | undefined;
  /** Each known dev container's state, by its local folder label; undefined until the engine answered. */
  readonly states: ContainerStates | undefined;
  refreshContainers(): Promise<void>;
  /** Starts a stopped dev container; resolves to why not, or undefined. */
  startContainer(localFolder: string): Promise<string | undefined>;
  /**
   * Remembers a folder and opens it; resolves to why not, or undefined. With `container` (a dev
   * container's local folder label), `path` is the repository inside that container.
   */
  addAndOpen(path: string, container?: string): Promise<string | undefined>;
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
  const [containers, setContainers] = useState<DevContainerList>();
  const refreshContainers = useCallback(async () => {
    if (!commands) return;
    try {
      setContainers(await commands.listDevContainers());
    } catch {
      // An engine that does not answer leaves the states unknown: the switcher says nothing of them.
      setContainers(undefined);
    }
  }, [commands]);
  const hasContainer = known?.some((k) => k.kind === "devcontainer") ?? false;
  useEffect(() => {
    if (hasContainer) void refreshContainers();
  }, [hasContainer, refreshContainers]);
  const startContainer = useCallback(
    async (localFolder: string) => {
      if (!commands) return "the app cannot start a container in a browser";
      try {
        await commands.startDevContainer(localFolder);
        return undefined;
      } catch (e) {
        return errorText(e);
      } finally {
        await refreshContainers();
      }
    },
    [commands, refreshContainers],
  );
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
    async (path: string, container?: string) => {
      if (!commands) return "the app cannot add a repository in a browser";
      let key = path;
      try {
        // A dev container's entry is the shell's key, not the path inside the container.
        key = (container ? await commands.addRepo(path, container) : await commands.addRepo(path)).path;
      } catch (e) {
        return errorText(e);
      }
      // The folder is remembered before the list grows: nothing else opens it a second time.
      const opened = open(key);
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
  const value: Repos = {
    commands,
    known,
    current,
    error,
    reload,
    containers,
    states: statesOf(containers),
    refreshContainers,
    startContainer,
    addAndOpen,
    open,
    remove,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The editor of a repository in a dev container (round 21): VS Code on this computer, attached to
 * the container (`editorChoice`), opened by the shell; undefined when the daemon opens the editor.
 */
export function useHostEditor(): HostEditor | undefined {
  const r = useContext(Ctx);
  const commands = r?.commands;
  const current = r?.current;
  return useMemo(() => {
    if (!commands || current?.kind !== "devcontainer") return undefined;
    return (at) => {
      const choice = editorChoice(current, at);
      if (choice.kind === "daemon") return undefined;
      return async () => {
        if (choice.kind === "none") return { ok: false, error: { message: choice.why } };
        try {
          await commands.openUri(choice.uri);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: { message: errorText(e) } };
        }
      };
    };
  }, [commands, current]);
}
