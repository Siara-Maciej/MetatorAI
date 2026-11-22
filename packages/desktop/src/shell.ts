/**
 * The app's shell (ADR-0101): what the Tauri window can do that a browser tab cannot. Today one
 * thing: ask the `metator` program for the daemon of a folder, starting it when none runs. In a
 * browser there is no shell, and the app only looks for a daemon somebody started.
 */
export interface Shell {
  /** The address of the daemon that serves `folder` (`metator serve --ensure`); rejects with why not. */
  ensureDaemon(folder: string): Promise<string>;
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function appShell(host: unknown = globalThis): Shell | undefined {
  const invoke = (host as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke;
  if (!invoke) return undefined;
  return { ensureDaemon: async (folder) => String(await invoke("ensure_daemon", { folder })) };
}
