/**
 * "New task from here…" (the Terminals): a draft of a Backlog task that points at a pane's run,
 * held until the Backlog's form takes it.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { navigate } from "../../shared/navigation.ts";

export interface BacklogDraft {
  readonly title?: string;
  readonly refs?: readonly { run?: string; step?: string }[];
}

const draftStore = createStore<{ readonly draft: BacklogDraft | undefined }>(() => ({ draft: undefined }));

/** Opens the Backlog with its form filled from the draft. */
export function draftInBacklog(draft?: BacklogDraft): void {
  draftStore.setState({ draft });
  navigate({ screen: "backlog" });
}

export const useBacklogDraft = (): BacklogDraft | undefined => useStore(draftStore, (s) => s.draft);

/** The Backlog was left: the draft goes with it. */
export const dropBacklogDraft = (): void => draftStore.setState({ draft: undefined });
