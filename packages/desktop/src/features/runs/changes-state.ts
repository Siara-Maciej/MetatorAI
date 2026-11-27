/**
 * What the Changes tab keeps while it is open (ADR-0113): the file shown (the route's), the note
 * being written, the diff line the keyboard is on, and what the last action answered. A row reads
 * only whether it is the file shown; a diff line only whether a note is written on it.
 */
import type { ReviewNote } from "../../shared/api/api.ts";
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { plural } from "../../shared/model/format.ts";
import { type ActionState, IDLE, runAction } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";

/** A note being written: on a line (and its side) of the file shown, or on the whole change. */
interface Draft {
  readonly line?: number;
  readonly side?: "old" | "new";
  readonly text: string;
}

/** The polled requests of the tab (one key each for every part). */
export const reviewKey = (repo: string | undefined, runId: string, file: string | undefined): string =>
  `review:${repo ?? ""}:${runId}:${file ?? ""}`;
export const notesKey = (repo: string | undefined, runId: string): string => `notes:${repo ?? ""}:${runId}`;

export interface ChangesState extends ActionState {
  readonly file: string | undefined;
  readonly draft: Draft | undefined;
  /** The diff line that is the Tab key's stop (its key); "" is the first line. */
  readonly active: string;

  /** The route named another file. */
  show(file: string | undefined): void;
  openDraft(draft: Draft): void;
  writeDraft(text: string): void;
  cancelDraft(): void;
  focusLine(key: string): void;
  /** Adds the draft as a note, on the file shown (and its line) or on the whole change. */
  add(): Promise<boolean>;
  /** Sends every draft note (`count` of them) to the run as one message. */
  send(count: number): Promise<boolean>;
  setStatus(note: ReviewNote, status: ReviewNote["status"]): Promise<boolean>;
  closeNotice(): void;
  /** Reads the change of the file shown and the notes again (after an action). */
  reload(): Promise<unknown>;
}

export interface ChangesInit {
  readonly daemon: Store<Daemon>;
  readonly runId: string;
  /** The run's own repository (D10): in a folder the change is read where the run lives. */
  readonly repo: string | undefined;
  readonly file: string | undefined;
}

export const Changes = scopedStore<ChangesState, ChangesInit>(
  "Changes",
  ({ daemon, runId, repo, file }) =>
    (set, get, api) => {
      const client = () => daemon.getState().client;
      // What an action answered stays until closed: a refresh never clears it (D5).
      const reload = () => {
        const { url } = daemon.getState();
        return Promise.all([
          readAgainNow(url, reviewKey(repo, runId, get().file)),
          readAgainNow(url, notesKey(repo, runId)),
        ]);
      };
      return {
        ...IDLE,
        file,
        draft: undefined,
        active: "",

        show: (shown) => set({ file: shown }),
        openDraft: (draft) => set({ draft }),
        writeDraft: (text) => set((s) => (s.draft ? { draft: { ...s.draft, text } } : {})),
        cancelDraft: () => set({ draft: undefined }),
        focusLine: (key) => set({ active: key }),
        add: async () => {
          const { draft, file: on } = get();
          if (!draft || draft.text.trim() === "") return false;
          const ok = await runAction(
            api,
            daemon,
            (by) =>
              client().addNote(
                runId,
                {
                  text: draft.text,
                  by,
                  ...(on ? { file: on } : {}),
                  ...(draft.line ? { line: draft.line, side: draft.side ?? "new" } : {}),
                },
                repo,
              ),
            { who: true, reload },
          );
          if (ok) set({ draft: undefined });
          return ok;
        },
        send: (count) =>
          runAction(api, daemon, (by) => client().sendNotes(runId, by, repo), {
            who: true,
            done: `sent ${plural(count, "note")} to the run`,
            reload,
          }),
        setStatus: (note, status) =>
          runAction(api, daemon, () => client().setNoteStatus(runId, note.id, status, repo), { reload }),
        closeNotice: () => set({ notice: undefined }),
        reload,
      };
    },
);

/** One value of the Changes tab's state: the part draws again only when it changed. */
export const useChanges = <T>(select: (s: ChangesState) => T): T => useScoped(Changes, select);
/** The store at the moment of an event: no subscription. */
export const useChangesApi = () => useScopedApi(Changes);
