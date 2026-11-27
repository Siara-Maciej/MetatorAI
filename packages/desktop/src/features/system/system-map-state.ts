/**
 * What the System map screen keeps while it is open (ADR-0113): what "Discover…" found, the roots
 * as a list being edited, and what the last action answered. The document itself is edited in the
 * DocEdit store (`plans/doc-editor-state.ts`).
 */
import type { SystemDiscoveryView, SystemMap, SystemMapView } from "../../shared/api/api.ts";
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { type ActionState, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped } from "../../shared/state/scoped-store.ts";
import type { DocSource } from "../plans/doc-editor-state.ts";
import { blankApplication, mapChanges } from "../plans/plan-edit.ts";

/** The polled request the screen reads the map of `repo` with (one key for every part). */
export const systemMapKey = (repo: string | undefined): string => `system-map:${repo ?? ""}`;

/** The map as a document the editor reads, checks and writes; every request reads the daemon then. */
export const mapSource = (daemon: Store<Daemon>): DocSource<SystemMapView, SystemMap> => ({
  reload: () => readAgainNow(daemon.getState().url, systemMapKey(daemon.getState().repo)),
  docOf: (v) => v.map,
  digestOf: (v) => v.digest,
  lintOf: (v) => v.lint,
  editable: (v) => v.editable,
  readOnlyBecause: (v) => v.readOnlyBecause,
  save: (m, digest, by) =>
    daemon.getState().client.saveSystemMap({ map: m as SystemMap, digest, by }, daemon.getState().repo),
  changes: mapChanges,
  blank: () =>
    ({
      system: "system",
      applications: [blankApplication({ applications: [] })],
      contracts: [],
      policies: { deployOrder: "providers-first", breaking: "expand-contract" },
    }) as SystemMap,
});

export interface SystemMapState extends ActionState {
  /** What "Discover…" found, until written or cancelled. */
  readonly found: SystemDiscoveryView | undefined;
  /** The roots as a list being edited: one path per row; undefined while nothing changed. */
  readonly rootsDraft: readonly string[] | undefined;

  /** Asks what the code shows (`write` false), or writes it as the map. */
  discover(write: boolean): Promise<boolean>;
  closeFound(): void;
  editRoots(next: readonly string[]): void;
  cancelRoots(): void;
  /** Saves the roots in the option's own scope; the options are read again either way. */
  saveRoots(paths: readonly string[], scope: "user" | "repo"): Promise<boolean>;
  closeNotice(): void;
}

export const SystemMapScreen = scopedStore<SystemMapState, { readonly daemon: Store<Daemon> }>(
  "SystemMap",
  ({ daemon }) =>
    (set, _get, api) => {
      const reload = () => readAgainNow(daemon.getState().url, systemMapKey(daemon.getState().repo));
      return {
        ...IDLE,
        found: undefined,
        rootsDraft: undefined,

        discover: async (write) => {
          let answer: SystemDiscoveryView | undefined;
          const { client, repo } = daemon.getState();
          const ok = await runAction(
            api,
            daemon,
            async (by) => {
              const r = await client.discover(write ? { write, by } : { write }, repo);
              answer = r.data;
              return r;
            },
            write
              ? { who: true, done: "the map is written", reload }
              : { refused: "discovery did not answer", reload },
          );
          if (ok) set({ found: write ? undefined : answer });
          return ok;
        },
        closeFound: () => set({ found: undefined }),
        editRoots: (next) => set({ rootsDraft: next }),
        cancelRoots: () => set({ rootsDraft: undefined }),
        saveRoots: async (paths, scope) => {
          const { client, repo, reloadOptions } = daemon.getState();
          const ok = await runAction(
            api,
            daemon,
            () => client.setOption("system.roots", { scope, value: paths.map((p) => p.trim()) }, repo),
            { done: "the roots are saved", reload },
          );
          if (ok) set({ rootsDraft: undefined });
          await reloadOptions();
          return ok;
        },
        closeNotice: () => set({ notice: undefined }),
      };
    },
);

/** One value of the System map screen's state: the part draws again only when it changed. */
export const useSystemMap = <T>(select: (s: SystemMapState) => T): T => useScoped(SystemMapScreen, select);
