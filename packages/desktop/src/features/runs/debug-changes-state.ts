/**
 * What "Debug changes" keeps while it is shown (ADR-0113): whether its list is open, what the last
 * removal said (in the entry's place once the list is closed, or in the list), the records the
 * daemon said are gone, and the list's action. Opening the list starts it afresh.
 */
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { dropText, forgetText, type ScratchDropped, type ScratchItem } from "../../shared/model/stage1.ts";
import { type ActionState, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";

interface Said {
  readonly text: string;
  readonly ok: boolean;
}
type Repos = readonly (string | undefined)[];

/** The request that lists the debug changes of `repos` (asked once per opening). */
export const scratchKey = (repos: Repos): string => `scratch:${repos.map((r) => r ?? "").join(",")}`;

export interface DebugChangesState extends ActionState {
  readonly open: boolean;
  /** What the last removal did, in the entry's place when nothing is left to list. */
  readonly said: Said | undefined;
  /**
   * Records the daemon says are gone (no file holds them any more): said once, by the answer that
   * removed them, so they are kept while the list is open.
   */
  readonly gone: string;
  /** What the last removal or forget did, in the list. */
  readonly listSaid: Said | undefined;

  openList(): void;
  /** Closes the list: what it leaves in the entry's place is `result`, else its last word, else what is gone. */
  closeList(result?: Said): void;
  dismiss(): void;
  noteGone(text: string): void;
  /** Removes one debug change, or every removable one of `repos` (`items` as listed). */
  drop(repos: Repos, items: readonly ScratchItem[], only?: ScratchItem): Promise<void>;
  /** Forgets a changed record: no file is touched; the person deals with its lines by hand. */
  forget(repos: Repos, item: ScratchItem): Promise<void>;
  closeNotice(): void;
}

export const DebugChanges = scopedStore<DebugChangesState, { readonly daemon: Store<Daemon> }>(
  "DebugChanges",
  ({ daemon }) =>
    (set, get, api) => {
      const reload = (repos: Repos) => readAgainNow(daemon.getState().url, scratchKey(repos));
      const close = (result?: Said) => {
        const { listSaid, gone } = get();
        const leaving = result ?? listSaid ?? (gone ? { text: gone, ok: true } : undefined);
        set({ open: false, ...(leaving ? { said: leaving } : {}) });
      };
      return {
        ...IDLE,
        open: false,
        said: undefined,
        gone: "",
        listSaid: undefined,

        openList: () => set({ ...IDLE, open: true, gone: "", listSaid: undefined }),
        closeList: close,
        dismiss: () => set({ said: undefined }),
        noteGone: (text) => set((s) => ({ gone: [s.gone, text].filter((x) => x !== "").join(" ") })),
        drop: async (repos, items, only) => {
          const { client } = daemon.getState();
          const results: ScratchDropped[] = [];
          // A changed record cannot be taken out: "all" asks for the removable ones by name when some are changed.
          const targets: { repo: string | undefined; ids?: string[] }[] = only
            ? [{ repo: only.repo, ids: [only.id] }]
            : repos.flatMap((repo) => {
                const mine = items.filter((i) => i.repo === repo);
                if (mine.every((i) => i.state === "removable")) return [{ repo }];
                const ids = mine.filter((i) => i.state === "removable").map((i) => i.id);
                return ids.length > 0 ? [{ repo, ids }] : [];
              });
          const ok = await runAction(
            api,
            daemon,
            async (by) => {
              let last: Awaited<ReturnType<typeof client.dropScratch>> = { ok: true };
              for (const t of targets) {
                last = await client.dropScratch({ ...(t.ids ? { ids: t.ids } : {}), by }, t.repo);
                if (!last.ok) return last;
                if (last.data) results.push(last.data);
              }
              return last;
            },
            { who: true, refused: "Nothing was removed" },
          );
          if (!ok) return;
          const result = dropText(results);
          await reload(repos);
          // Everything went: the list closes and the line stays where the entry was.
          if (!only && result.ok && items.every((i) => i.state === "removable")) close(result);
          else set({ listSaid: result });
        },
        forget: async (repos, item) => {
          const { client } = daemon.getState();
          let text: string | undefined;
          const ok = await runAction(
            api,
            daemon,
            async (by) => {
              const r = await client.forgetScratch({ ids: [item.id], by }, item.repo);
              if (r.ok && r.data) text = forgetText(r.data);
              return r;
            },
            { who: true, refused: "Nothing was forgotten" },
          );
          if (!ok) return;
          await reload(repos);
          set({ listSaid: { text: text ?? "Forgotten.", ok: true } });
        },
        closeNotice: () => set({ notice: undefined }),
      };
    },
);

/** One value of the debug changes' state: the part draws again only when it changed. */
export const useDebugChanges = <T>(select: (s: DebugChangesState) => T): T => useScoped(DebugChanges, select);
/** The store at the moment of an event: no subscription. */
export const useDebugChangesApi = () => useScopedApi(DebugChanges);
