/**
 * What the New run form keeps while it is open (ADR-0113): the repository, the choices the person
 * made, the task being written, and what the last create answered. A store per open form: closing
 * the dialog drops it. Each field of the form reads only its own value.
 */
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { type ActionState, IDLE, sayIn } from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { refusedForDirtyTree } from "./model.ts";

/** What a create sends, resolved from what the form offers and what the person chose. */
export interface RunChoice {
  readonly workflow: string;
  readonly host: string;
  readonly autonomy: string;
}

export interface NewRunState extends ActionState {
  readonly repo: string;
  /** The workflow the person chose; a feature (or the first) when none. */
  readonly wantedWorkflow: string | undefined;
  readonly task: string;
  /** The host the person chose ("" creates only); the first installed one of the order when none. */
  readonly wantedHost: string | undefined;
  readonly wantedAutonomy: string;
  readonly worktree: boolean;
  readonly parent: string;
  /** The read failure the person closed: it shows again only when another one comes. */
  readonly hiddenError: string | undefined;
  /** The last create was refused for uncommitted changes: how to create without them. */
  readonly dirty: { readonly andAttach: boolean } | undefined;

  setRepo(repo: string): void;
  setWorkflow(workflow: string): void;
  setTask(task: string): void;
  setHost(host: string): void;
  setAutonomy(level: string): void;
  setWorktree(on: boolean): void;
  setParent(runId: string): void;
  hideError(error: string | undefined): void;
  closeNotice(): void;
  /**
   * Creates the run (and drives it on `choice.host`): its id once it runs; a refusal, or a run
   * that exists but did not start, stays said in the notice.
   */
  create(andAttach: boolean, choice: RunChoice, allowDirty?: boolean): Promise<string | undefined>;
}

export interface NewRunInit {
  readonly daemon: Store<Daemon>;
}

export const NewRun = scopedStore<NewRunState, NewRunInit>("NewRun", ({ daemon }) => (set, get, api) => ({
  ...IDLE,
  repo: daemon.getState().repo ?? "",
  wantedWorkflow: undefined,
  task: "",
  wantedHost: undefined,
  wantedAutonomy: "L0",
  worktree: true,
  parent: "",
  hiddenError: undefined,
  dirty: undefined,

  setRepo: (repo) => set({ repo }),
  setWorkflow: (workflow) => set({ wantedWorkflow: workflow }),
  setTask: (task) => set({ task }),
  setHost: (host) => set({ wantedHost: host }),
  setAutonomy: (level) => set({ wantedAutonomy: level }),
  setWorktree: (on) => set({ worktree: on }),
  setParent: (runId) => set({ parent: runId }),
  hideError: (error) => set({ hiddenError: error }),
  closeNotice: () => set({ notice: undefined, dirty: undefined }),

  create: async (andAttach, { workflow, host, autonomy }, allowDirty = false) => {
    set({ dirty: undefined });
    const { task, worktree, parent, repo } = get();
    if (!workflow || !task.trim()) {
      sayIn(api, "a workflow and a task are needed");
      return undefined;
    }
    set({ busy: true });
    const r = await daemon.getState().client.createRun(
      {
        workflow,
        task: task.trim(),
        autonomy,
        worktree,
        ...(parent ? { parent } : {}),
        ...(host ? { drive: host } : {}),
        ...(allowDirty ? { allowDirty: true } : {}),
      },
      repo || undefined,
    );
    set({ busy: false });
    if (!r.ok || !r.data) {
      sayIn(api, r.error?.message ?? "the run was not created");
      if (refusedForDirtyTree(r.error)) set({ dirty: { andAttach } });
      return undefined;
    }
    // The run exists but nothing drives it: the dialog stays to say so (the run is in the panel).
    if (r.data.drive?.error) {
      sayIn(
        api,
        `The run was created, but its agent did not start: ${r.data.drive.error} Open it from the panel on the left.`,
      );
      return undefined;
    }
    return r.data.run.runId;
  },
}));

/** One value of the New run form's state: the part draws again only when it changed. */
export const useNewRun = <T>(select: (s: NewRunState) => T): T => useScoped(NewRun, select);
/** The store at the moment of an event: no subscription. */
export const useNewRunApi = () => useScopedApi(NewRun);
