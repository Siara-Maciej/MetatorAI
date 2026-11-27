/**
 * What the small parts of a run's page keep while they are shown (ADR-0113), a store each: the
 * page's own action (its driver bar, its notice, the editor's key), the Overview's action, the
 * artifact opened, the host a start goes to, the answer a task's page just gave, and the debug
 * changes' entry and list.
 */
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { type ActionState, IDLE } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";

/** A part's action and nothing else: busy, and what it answered until closed (D5). */
export interface ActsState extends ActionState {
  closeNotice(): void;
}
const acts = (set: (p: Partial<ActsState>) => void): ActsState => ({
  ...IDLE,
  closeNotice: () => set({ notice: undefined }),
});

/** The run page's action: Open a session, Drive in background, the editor (`e`). */
export const RunPage = scopedStore<ActsState, { readonly daemon: Store<Daemon> }>(
  "RunPage",
  () => (set) => acts(set),
);
export const useRunPage = <T>(select: (s: ActsState) => T): T => useScoped(RunPage, select);
export const useRunPageApi = () => useScopedApi(RunPage);

/** A step's Overview's action: Mark as read. */
export const Overview = scopedStore<ActsState, undefined>("Overview", () => (set) => acts(set));
export const useOverview = <T>(select: (s: ActsState) => T): T => useScoped(Overview, select);
export const useOverviewApi = () => useScopedApi(Overview);

/** The artifact opened read-only, if any. */
export interface ArtifactsState {
  readonly viewing: string | undefined;
  view(name: string | undefined): void;
}
export const Artifacts = scopedStore<ArtifactsState, undefined>("Artifacts", () => (set) => ({
  viewing: undefined,
  view: (name) => set({ viewing: name }),
}));
export const useArtifacts = <T>(select: (s: ArtifactsState) => T): T => useScoped(Artifacts, select);

/** The host the person chose for a start; the run's own, or the first installed one, when none. */
export interface StartHostState {
  readonly chosen: string | undefined;
  choose(host: string): void;
}
export const StartHost = scopedStore<StartHostState, undefined>("StartHost", () => (set) => ({
  chosen: undefined,
  choose: (host) => set({ chosen: host }),
}));
export const useStartHost = <T>(select: (s: StartHostState) => T): T => useScoped(StartHost, select);

/** What a task's page says once its question was answered there. */
export interface TaskSaidState {
  readonly said: string | undefined;
  answered(choices: readonly string[]): void;
}
export const TaskSaid = scopedStore<TaskSaidState, undefined>("TaskSaid", () => (set) => ({
  said: undefined,
  answered: (choices) => set({ said: `Answered: ${choices.join(", ")}.` }),
}));
export const useTaskSaid = <T>(select: (s: TaskSaidState) => T): T => useScoped(TaskSaid, select);
