/**
 * What Settings keeps while it is open (ADR-0113): the section shown, the search, which fields
 * were refused (a refused field is drawn again with the value that holds, D6), and what the last
 * change answered. The app's own settings (which metator, the command installed) have their own
 * store. A part reads only the value it draws; the daemon's options are read from its store.
 */
import { useStore } from "zustand";
import type { OptionScope, ResolvedOption } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { refusalText } from "../../shared/model/format.ts";
import {
  type CliInfo,
  type CliSource,
  type Commands,
  errorText,
} from "../../shared/platform/tauri-commands.ts";
import { type ActionState, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { installedText } from "../repos/repos.ts";

export interface SettingsState extends ActionState {
  /** The daemon's store: the options a part reads, by selector. */
  readonly daemon: Store<Daemon>;
  /** The group shown ("app": this window's own fields). */
  readonly section: string;
  readonly query: string;
  /** How many times each option's change was refused: its field is drawn again with what holds. */
  readonly refusals: Readonly<Record<string, number>>;

  search(query: string): void;
  /** A section chosen: the search is cleared. */
  open(section: string): void;
  closeNotice(): void;
  /** Sets (or with `reset` puts back to its default) an option; the options are read again either way. */
  change(option: ResolvedOption, value: unknown, reset?: boolean): Promise<boolean>;
}

export interface SettingsInit {
  readonly daemon: Store<Daemon>;
}

export const Settings = scopedStore<SettingsState, SettingsInit>(
  "Settings",
  ({ daemon }) =>
    (set, _get, api) => ({
      ...IDLE,
      daemon,
      section: "ui",
      query: "",
      refusals: {},

      search: (query) => set({ query }),
      open: (section) => set({ query: "", section }),
      closeNotice: () => set({ notice: undefined }),
      change: async (o, value, reset = false) => {
        const scope: OptionScope = o.definition.scope === "user" ? "user" : "repo";
        const { client, repo } = daemon.getState();
        // The options are read again either way: a refused value must not stay in the field (D6).
        const ok = await runAction(
          api,
          daemon,
          async () => {
            const r = await client.setOption(o.key, reset ? { scope, reset: true } : { scope, value }, repo);
            return r.ok
              ? r
              : {
                  ok: false,
                  error: {
                    code: r.error?.code ?? "REFUSED",
                    message: `${o.key} was not changed: ${refusalText(r.error)}`,
                  },
                };
          },
          { reload: () => daemon.getState().reloadOptions() },
        );
        if (!ok) set((s) => ({ refusals: { ...s.refusals, [o.key]: (s.refusals[o.key] ?? 0) + 1 } }));
        return ok;
      },
    }),
);

/** One value of Settings' state: the part draws again only when it changed. */
export const useSettings = <T>(select: (s: SettingsState) => T): T => useScoped(Settings, select);
/** The store at the moment of an event: no subscription. */
export const useSettingsApi = () => useScopedApi(Settings);
/** One value of the daemon's state, read through Settings' store. */
export const useSettingsDaemon = <T>(select: (d: Daemon) => T): T =>
  useStore(useSettingsApi().getState().daemon, select);

/* ---------- the app's own settings ---------- */

type Said = { readonly text: string; readonly tone: "error" | "info" };

export interface AppSettingsState {
  /** Which metator the app runs, once read. */
  readonly info: CliInfo | undefined;
  /** A path the person chose (or is writing). */
  readonly custom: string;
  /** Where "Install the metator command" wrote it. */
  readonly installed: string | undefined;
  readonly said: Said | undefined;

  setCustom(path: string): void;
  say(said: Said | undefined): void;
  /** Reads which metator the app runs; a custom one fills the path field. */
  read(): Promise<void>;
  choose(source: CliSource, path?: string): Promise<void>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
}

export interface AppSettingsInit {
  readonly commands: Commands;
}

export const AppSettingsStore = scopedStore<AppSettingsState, AppSettingsInit>(
  "AppSettings",
  ({ commands }) =>
    (set) => {
      /** One command: what it says, or why it failed. */
      const act = async (what: () => Promise<string>, failed: string) => {
        set({ said: undefined });
        try {
          set({ said: { text: await what(), tone: "info" } });
        } catch (e) {
          set({ said: { text: `${failed}: ${errorText(e)}`, tone: "error" } });
        }
      };
      return {
        info: undefined,
        custom: "",
        installed: undefined,
        said: undefined,

        setCustom: (custom) => set({ custom }),
        say: (said) => set({ said }),
        read: async () => {
          try {
            const info = await commands.cliInfo();
            set(info.source === "custom" ? { info, custom: info.path } : { info });
          } catch (e) {
            set({
              said: { text: `The app could not say which metator it uses: ${errorText(e)}`, tone: "error" },
            });
          }
        },
        choose: (source, path) =>
          act(async () => {
            const next = await commands.setCliSource(source, path);
            set({ info: next });
            return `The app now runs ${next.path}.`;
          }, "The source was not changed"),
        install: () =>
          act(async () => {
            const r = await commands.installCliCommand();
            set({ installed: r.path });
            return installedText(r);
          }, "The command was not installed"),
        uninstall: () =>
          act(async () => {
            const r = await commands.uninstallCliCommand();
            set({ installed: undefined });
            return r.path ? `Removed ${r.path}.` : "There was no metator command to remove.";
          }, "The command was not removed"),
      };
    },
);

/** One value of the app settings' state. */
export const useAppSettings = <T>(select: (s: AppSettingsState) => T): T =>
  useScoped(AppSettingsStore, select);
/** The app settings' store at the moment of an event. */
export const useAppSettingsApi = () => useScopedApi(AppSettingsStore);
