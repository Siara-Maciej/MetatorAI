/**
 * What opens over the app (the keys' help, the new-run form): any part of the app opens one, the
 * shell draws it.
 */
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

interface Overlays {
  readonly help: boolean;
  readonly newRun: boolean;
}

const overlayStore = createStore<Overlays>(() => ({ help: false, newRun: false }));

export const openHelp = (): void => overlayStore.setState({ help: true });
export const closeHelp = (): void => overlayStore.setState({ help: false });
/** The form: workflow, autonomy, host and worktree chosen by hand. */
export const openNewRun = (): void => overlayStore.setState({ newRun: true });
export const closeNewRun = (): void => overlayStore.setState({ newRun: false });

export const useOverlays = (): Overlays =>
  useStore(
    overlayStore,
    useShallow((s: Overlays) => s),
  );
