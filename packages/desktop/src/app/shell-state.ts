/**
 * What the shell keeps (ADR-0113: app-wide, a store outside React): whether the sidebar's drawer is
 * open (below about 1000 px the sidebar is a drawer behind a button of the top bar). A move closes
 * it, and so does a key that goes somewhere.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

const drawerStore = createStore<{ readonly open: boolean }>(() => ({ open: false }));

export const toggleDrawer = (): void => drawerStore.setState((s) => ({ open: !s.open }));
export const closeDrawer = (): void => drawerStore.setState({ open: false });
export const useDrawerOpen = (): boolean => useStore(drawerStore, (s) => s.open);
