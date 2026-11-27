/**
 * What the repository screens keep while they are open (ADR-0113), each a store of its own:
 * Add repository's two flows (the steps are the pure `flowStep` and `containerStep`, driven by the
 * store's actions), the browser's version of it, the panel of a dev container the window lost,
 * the first run's check of this computer's tools, and the switcher's menu.
 */
import { type Commands, type DevContainer, errorText } from "../../shared/platform/tauri-commands.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { type ContainerEvent, type ContainerFlow, containerStep, LISTING } from "./devcontainers.ts";
import { type Flow, type FlowEvent, flowStep, type Requirement, requirements, START } from "./repos.ts";
import { reposActs } from "./repos-context.tsx";

/** Where the repository comes from. */
export type Source = "folder" | "repos" | "devcontainer";

export interface AddRepoState {
  readonly source: Source;
  readonly flow: Flow;
  /** The Dev Container source's own steps: list, start, install. */
  readonly boxes: ContainerFlow;
  /** The dev container the flow runs in, once MetatorAI is installed there; none on this computer. */
  readonly place: DevContainer | undefined;
  /** A command's whole output is shown. */
  readonly output: boolean;
  /** Why the folder picker did not open. */
  readonly pickError: string | undefined;

  choose(source: Source): void;
  dispatch(e: FlowEvent): void;
  box(e: ContainerEvent): void;
  toggleOutput(): void;
  /** The shell's folder picker; a folder picked is inspected. */
  pick(): Promise<void>;
  /** Change: back to the folder, or to the list of dev containers. */
  change(): void;
  /** Installed in a container: the round-20 flow takes over there, at its workspace folder. */
  installed(container: DevContainer): void;
}

export const AddRepo = scopedStore<AddRepoState, { readonly commands: Commands }>(
  "AddRepo",
  ({ commands }) =>
    (set, get) => {
      const dispatch = (e: FlowEvent) => set((s) => ({ flow: flowStep(s.flow, e) }));
      const box = (e: ContainerEvent) => set((s) => ({ boxes: containerStep(s.boxes, e) }));
      return {
        source: "folder",
        flow: START,
        boxes: LISTING,
        place: undefined,
        output: false,
        pickError: undefined,

        choose: (source) => set({ source }),
        dispatch,
        box,
        toggleOutput: () => set((s) => ({ output: !s.output })),
        pick: async () => {
          set({ pickError: undefined });
          try {
            const path = await commands.pickFolder();
            if (path) dispatch({ type: "inspect", path });
          } catch (e) {
            set({ pickError: `The folder picker did not open: ${errorText(e)}. Type the path instead.` });
          }
        },
        change: () => {
          dispatch({ type: "back" });
          if (get().place) {
            set({ place: undefined });
            box({ type: "back" });
            dispatch({ type: "type", path: "" });
          }
        },
        installed: (container) => {
          set({ place: container });
          dispatch({ type: "inspect", path: container.workspaceFolder ?? "" });
        },
      };
    },
);

export const useAddRepo = <T>(select: (s: AddRepoState) => T): T => useScoped(AddRepo, select);
export const useAddRepoApi = () => useScopedApi(AddRepo);

/** The flow is at its first step, on this computer: the source and the folder are chosen. */
export const isPicking = (s: Pick<AddRepoState, "flow" | "place">): boolean =>
  s.flow.step === "pick" && !s.place;

export interface WebAddState {
  readonly path: string;
  readonly host: string;
  typePath(path: string): void;
  chooseHost(host: string): void;
}

/** The browser's Add repository: the folder and the host the commands are for. */
export const WebAdd = scopedStore<WebAddState, undefined>("WebAdd", () => (set) => ({
  path: "",
  host: "claude",
  typePath: (path) => set({ path }),
  chooseHost: (host) => set({ host }),
}));

export const useWebAdd = <T>(select: (s: WebAddState) => T): T => useScoped(WebAdd, select);

export interface ContainerPanelState {
  /** What runs now: a start of the container, or a reconnect. */
  readonly busy: "start" | "reconnect" | undefined;
  /** Why the last one did not work. */
  readonly why: string | undefined;
  /** Asks the shell for the daemon of `path` again. */
  reconnect(path: string): Promise<void>;
  /** Starts the container of `local`, then reconnects to `path`. */
  start(local: string, path: string): Promise<void>;
}

export interface ContainerPanelInit {
  /** Starts (or finds) the daemon of a folder; resolves to why not. */
  readonly startDaemon: (folder: string) => Promise<string | undefined>;
}

/** The panel of a dev container the window lost: Start and Reconnect, one at a time. */
export const ContainerPanel = scopedStore<ContainerPanelState, ContainerPanelInit>(
  "ContainerPanel",
  ({ startDaemon }) =>
    (set, get) => ({
      busy: undefined,
      why: undefined,
      reconnect: async (path) => {
        set({ busy: "reconnect", why: undefined });
        const failed = await startDaemon(path);
        await reposActs.refreshContainers();
        set({ busy: undefined });
        if (failed) set({ why: failed });
      },
      start: async (local, path) => {
        set({ busy: "start", why: undefined });
        const failed = await reposActs.startContainer(local);
        if (failed) {
          set({ busy: undefined, why: failed });
          return;
        }
        await get().reconnect(path);
      },
    }),
);

export const useContainerPanel = <T>(select: (s: ContainerPanelState) => T): T =>
  useScoped(ContainerPanel, select);

export interface FirstRunState {
  /** What this computer has of what MetatorAI needs; undefined until checked. */
  readonly needs: readonly Requirement[] | undefined;
  /** Why the app could not check. */
  readonly error: string | undefined;
  check(): Promise<void>;
}

/** The first run's check of this computer's tools. */
export const FirstRunCheck = scopedStore<FirstRunState, { readonly commands: Commands | undefined }>(
  "FirstRunCheck",
  ({ commands }) =>
    (set) => ({
      needs: undefined,
      error: undefined,
      check: async () => {
        if (!commands) return;
        set({ error: undefined });
        try {
          // Any folder tells which tools this computer has: the one the app runs in.
          set({ needs: requirements(await commands.inspectFolder(".")) });
        } catch (e) {
          set({ error: errorText(e) });
        }
      },
    }),
);

export const useFirstRun = <T>(select: (s: FirstRunState) => T): T => useScoped(FirstRunCheck, select);

export interface SwitcherState {
  /** Where the menu is open; undefined while closed. */
  readonly at: { readonly x: number; readonly y: number } | undefined;
  /** Why the last act on a repository did not work. */
  readonly refusal: string | undefined;
  openAt(at: { readonly x: number; readonly y: number }): void;
  close(): void;
  /** An act on a repository: its refusal shows until the next act. */
  act(p: Promise<string | undefined>): void;
}

/** The repository switcher's menu and what its last act answered. */
export const Switcher = scopedStore<SwitcherState, undefined>("Switcher", () => (set) => ({
  at: undefined,
  refusal: undefined,
  openAt: (at) => set({ at }),
  close: () => set({ at: undefined }),
  act: (p) => {
    set({ refusal: undefined });
    void p.then((why) => set({ refusal: why }));
  },
}));

export const useSwitcher = <T>(select: (s: SwitcherState) => T): T => useScoped(Switcher, select);
