/**
 * The app's shell (ADR-0101, ADR-0105): what the Tauri window can do that a browser tab cannot.
 * Here, the one thing the daemon's connection needs: the address of a repository's daemon,
 * started with the bundled `metator` when none runs (`open_repo`). The rest of the shell's
 * commands are in `tauri-commands.ts`. In a browser there is no shell, and the app only looks for
 * a daemon somebody started.
 */
import { appCommands } from "./app-commands.ts";

export interface Shell {
  /** The address of the daemon that serves `folder` (`metator serve --ensure`); rejects with why not. */
  ensureDaemon(folder: string): Promise<string>;
}

export function appShell(host: unknown = globalThis): Shell | undefined {
  const commands = appCommands(host);
  if (!commands) return undefined;
  return { ensureDaemon: async (folder) => (await commands.openRepo(folder)).url };
}
