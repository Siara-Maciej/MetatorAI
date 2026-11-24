/**
 * What this window keeps of the person (ADR-0108): the daemon's address, their name and the one
 * dialog that asks for it, the repository the list screens show, the runs they have seen, and the
 * folder whose daemon the app starts. A store outside React: its actions are plain functions, so a
 * component, an effect or another store calls them alike. Each field is kept in the window's
 * storage under its own key (`metator.daemon`, `metator.me`, `metator.repo`, `metator.seen`,
 * `metator.folder`), as before, read and written under try/catch.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { daemonUrl } from "../api/api.ts";
import { autostart, type SeenRuns, seenFrom, seenKey, withSeen } from "../model/session.ts";
import { errorText } from "../platform/tauri-commands.ts";
import { appShell, type Shell } from "./shell.ts";

export interface Session {
  /** The daemon's address: `?daemon=` in the page's address, the saved one, or the default. */
  readonly url: string;
  /** The person's name ("" until they give it). */
  readonly me: string;
  /** The name dialog is open. */
  readonly asking: boolean;
  /** The repository the person chose for the list screens, as saved. */
  readonly savedRepo: string | null;
  readonly seen: SeenRuns;
  /** The folder the app starts the daemon for ("" when none). */
  readonly folder: string;
  readonly starting: boolean;
  readonly startError: string | undefined;
}

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

/** The window's session and its shell, made once, on first use (a test imports this without a window). */
let made: { readonly store: StoreApi<Session>; readonly shell: Shell | undefined } | undefined;
const session = () =>
  (made ??= {
    store: createStore<Session>(() => ({
      url: daemonUrl(window.location.search, read("metator.daemon")),
      me: read("metator.me") ?? "",
      asking: false,
      savedRepo: read("metator.repo"),
      seen: seenFrom(read("metator.seen")),
      folder: read("metator.folder") ?? "",
      starting: false,
      startError: undefined,
    })),
    shell: appShell(),
  });

export const sessionStore = (): StoreApi<Session> => session().store;
/** The app's shell can start the daemon itself (ADR-0101); none in a browser. */
export const sessionShell = (): Shell | undefined => session().shell;

const set = (part: Partial<Session>) => sessionStore().setState(part);

/** Points the app at another daemon. */
export function setUrl(address: string): void {
  const clean = address.trim().replace(/\/+$/, "");
  write("metator.daemon", clean);
  set({ url: clean });
}

export function setMe(name: string): void {
  write("metator.me", name);
  set({ me: name });
}

/** Opens the name dialog to change the saved name. */
export function changeName(): void {
  set({ asking: true });
}

// The name dialog: one question at a time; everyone who asked gets the same answer.
const waiters: ((name: string) => void)[] = [];

/** The person's name: the saved one, or asked for once in the app's own dialog ("" when they cancel). */
export function who(): Promise<string> {
  const { me } = sessionStore().getState();
  if (me) return Promise.resolve(me);
  return new Promise((resolve) => {
    waiters.push(resolve);
    set({ asking: true });
  });
}

/** The dialog closed with a name, or "" when cancelled: everyone who waited gets it. */
export function settleName(name: string): void {
  if (name) setMe(name);
  set({ asking: false });
  for (const w of waiters.splice(0)) w(name);
}

export function setRepo(name: string): void {
  write("metator.repo", name);
  set({ savedRepo: name });
}

/** The run was opened now. */
export function markSeen(run: { readonly runId: string; readonly repo?: string | undefined }): void {
  const after = withSeen(sessionStore().getState().seen, seenKey(run), new Date().toISOString());
  write("metator.seen", JSON.stringify(after));
  set({ seen: after });
}

// The last folder the app tried to start a daemon for: a daemon that does not answer is not
// started again for it, until one answered (`daemonAnswered`).
let tried: string | undefined;

/**
 * Starts (or finds) the daemon of a folder and points the app at it; remembers the folder.
 * Resolves to why it did not start, or undefined when it did.
 */
export async function start(dir: string): Promise<string | undefined> {
  const shell = sessionShell();
  const clean = dir.trim();
  if (!shell || clean === "") return "no folder to start the daemon in";
  write("metator.folder", clean);
  tried = clean;
  set({ folder: clean, starting: true, startError: undefined });
  const why = await shell.ensureDaemon(clean).then(
    (address) => {
      setUrl(address);
      return undefined;
    },
    (e: unknown) => (e instanceof Error ? e.message : errorText(e)),
  );
  set({ starting: false, ...(why !== undefined ? { startError: why } : {}) });
  return why;
}

/** Forgets the remembered folder (it was removed from the app): nothing is started for it again. */
export function forgetFolder(): void {
  write("metator.folder", "");
  tried = undefined;
  set({ folder: "" });
}

/**
 * What the connection says, for the daemon the app starts itself: one that answered and then went
 * away is started again, by itself; one that never answered is tried once per folder.
 */
export function daemonAnswered(connected: boolean, down: boolean): void {
  if (connected) tried = undefined;
  const { folder, starting } = sessionStore().getState();
  if (autostart({ shell: sessionShell() !== undefined, down, folder, tried, starting }) === "start")
    void start(folder);
}
