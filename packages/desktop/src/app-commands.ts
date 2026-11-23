/**
 * Which commands this window uses (round 20): the fake a test put at `__METATOR_FAKE__`, Tauri's in
 * the app's window, none in a browser tab. Apart from tauri-commands.ts so the wrapper and the fake
 * do not import each other.
 */
import { type FakeWorld, fakeCommands } from "./fake-commands.ts";
import { type Commands, type Listen, type TauriGlobal, tauriCommands } from "./tauri-commands.ts";

/**
 * The commands this window has: the fake when a test put its world at `__METATOR_FAKE__` (the
 * e2e's hook), Tauri's in the app's window, none in a browser tab.
 */
export function appCommands(host: unknown = globalThis): Commands | undefined {
  if (typeof host !== "object" || host === null) return undefined;
  // One per window: the shell and the screens share the fake's world and its listeners.
  if (made.has(host)) return made.get(host);
  const w = host as { __METATOR_FAKE__?: FakeWorld; __TAURI__?: TauriGlobal };
  const invoke = w.__TAURI__?.core?.invoke;
  const listen: Listen = w.__TAURI__?.event?.listen ?? (async () => () => undefined);
  const commands = w.__METATOR_FAKE__
    ? fakeCommands(w.__METATOR_FAKE__, host)
    : invoke
      ? tauriCommands(invoke, listen)
      : undefined;
  made.set(host, commands);
  return commands;
}

const made = new WeakMap<object, Commands | undefined>();
