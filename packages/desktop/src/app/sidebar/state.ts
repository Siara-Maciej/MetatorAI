/**
 * What the sidebar keeps (ADR-0113: app-wide, a store outside React): what is folded or unfolded by
 * hand (a task, a thread, a group's finished tasks), the closed chats shown, a chat's open menu, the menu of "+ New chat", and
 * the tree it draws (`tree.ts`), published with every unchanged row kept the same object, so a row
 * reads only its own entry and draws again only when it changed.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { shared } from "../../shared/api/query.ts";
import { EMPTY_TREE, type SideTree } from "./tree.ts";

export interface ThreadMenu {
  readonly threadId: string;
  readonly title: string;
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
}

export interface SidebarState {
  /** Folded or unfolded by hand, by key; a key not here follows its default. */
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly showClosed: boolean;
  readonly menu: ThreadMenu | undefined;
  /** Where the menu of "+ New chat" is open (a folder: the folder or one repository), if it is. */
  readonly chatMenu: { readonly x: number; readonly y: number } | undefined;
  readonly tree: SideTree;
}

export const sidebarStore = createStore<SidebarState>(() => ({
  expanded: {},
  showClosed: false,
  menu: undefined,
  chatMenu: undefined,
  tree: EMPTY_TREE,
}));

/** Folds (false) or unfolds (true) what `key` names, by hand. */
export const fold = (key: string, open: boolean): void =>
  sidebarStore.setState((s) => ({ expanded: { ...s.expanded, [key]: open } }));
export const toggleClosed = (): void => sidebarStore.setState((s) => ({ showClosed: !s.showClosed }));
export const showMenu = (menu: ThreadMenu): void => sidebarStore.setState({ menu });
export const closeMenu = (): void => sidebarStore.setState({ menu: undefined });
export const showChatMenu = (x: number, y: number): void => sidebarStore.setState({ chatMenu: { x, y } });
export const closeChatMenu = (): void => sidebarStore.setState({ chatMenu: undefined });

/** The tree as the daemon's state makes it now: what did not change stays the same object. */
export const publishTree = (next: SideTree): void =>
  sidebarStore.setState((s) => ({ tree: shared(s.tree, next) }));

/** One value of the sidebar's state: the part draws again only when it changed. */
export const useSidebar = <T>(select: (s: SidebarState) => T): T => useStore(sidebarStore, select);
