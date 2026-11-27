/**
 * What the Backlog screen keeps while it is open (ADR-0113): the item chosen, the workflow a run
 * starts on, the new-task form, the fold of finished tasks, and what the last action answered. The
 * actions that ask the daemon live here too; a part of the screen calls them and reads only the
 * value it draws.
 */
import type { Issue, IssueView, PlanStarted } from "../../shared/api/api.ts";
import { confirmed } from "../../shared/confirm.ts";
import { type Daemon, readAgainNow } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { navigate } from "../../shared/navigation.ts";
import {
  type ActionOptions,
  type ActionState,
  type Answer,
  IDLE,
  runAction,
  sayIn,
} from "../../shared/state/action.ts";
import { scopedStore, useScoped, useScopedApi } from "../../shared/state/scoped-store.ts";
import { refusedForDirtyTree } from "../runs/model.ts";
import type { BacklogDraft } from "./draft.ts";
import { finishQuestion, newTaskProblem, shownRoute } from "./model.ts";

export interface TaskDraft {
  readonly title: string;
  readonly body: string;
  readonly priority: Issue["priority"];
  readonly labels: string;
}

const EMPTY_DRAFT: TaskDraft = { title: "", body: "", priority: "normal", labels: "" };

const NO_WORKFLOW: Answer = {
  ok: false,
  error: { message: "This repository has no workflow to start a run on. `metator setup` installs them." },
};

/** The polled request the screen lists the tasks of `repo` with (one key for every part). */
export const issuesKey = (repo: string | undefined): string => `issues:${repo ?? ""}`;

export interface BacklogState extends ActionState {
  /** The item the person chose; the route's (`routeId`) when none, the first one when neither. */
  readonly picked: string | undefined;
  readonly routeId: string | undefined;
  /** The workflow the person chose for a run; the default when none. */
  readonly wanted: string | undefined;
  readonly adding: boolean;
  readonly draft: TaskDraft;
  /** What a draft from "New task from here…" points at. */
  readonly refs: NonNullable<BacklogDraft["refs"]>;
  readonly showDone: boolean;
  /** The last start was refused for uncommitted changes: the same start, from the last commit. */
  readonly retry: (() => void) | undefined;

  pick(id: string): void;
  /** The route named another item: it wins over the one picked. */
  routeTo(id: string | undefined): void;
  want(workflow: string): void;
  openForm(): void;
  closeForm(): void;
  edit<K extends keyof TaskDraft>(field: K, value: TaskDraft[K]): void;
  toggleDone(): void;
  closeNotice(): void;

  decide(issue: Issue, decision: "add" | "drop"): Promise<boolean>;
  /** Added and started in one click; refused for uncommitted changes, the retry is the plain start. */
  addAndStart(issue: IssueView, workflow: string | undefined): Promise<boolean>;
  /**
   * Implement: with a plan (or as a system plan step's part) the run starts on the workflow that
   * names, unless the person chose one; the conductor's terminal shows.
   */
  start(issue: IssueView, workflow: string | undefined, allowDirty?: boolean): Promise<boolean>;
  /** Analyse opens an mt-guide pane: the app shows that terminal. */
  analyse(issue: IssueView): Promise<boolean>;
  /** Make plan starts a run `--until plan` with its conductor: the app shows that terminal. */
  makePlan(issue: IssueView): Promise<boolean>;
  add(): Promise<boolean>;
  /** Done and Drop cannot be taken back in the app: asked first. */
  finish(issue: IssueView, how: "done" | "drop"): Promise<boolean>;
}

export interface BacklogInit {
  readonly daemon: Store<Daemon>;
  readonly routeId: string | undefined;
  readonly draft: BacklogDraft | undefined;
  /** Opens a run's page (a run that has no pane to show). */
  readonly openRun: (runId: string) => void;
}

export const Backlog = scopedStore<BacklogState, BacklogInit>(
  "Backlog",
  ({ daemon, routeId, draft, openRun }) =>
    (set, get, api) => {
      const repo = () => daemon.getState().repo;
      const client = () => daemon.getState().client;
      /** One action: busy, its answer as the notice, the tasks read again; `again` after a dirty-tree refusal. */
      const act = (
        request: (by: string) => Promise<Answer>,
        again?: () => void,
        options: ActionOptions = {},
      ) => {
        set({ retry: undefined });
        return runAction(api, daemon, request, {
          who: true,
          ...options,
          onRefused: (error) => {
            if (again && refusedForDirtyTree(error)) set({ retry: again });
          },
          reload: () => readAgainNow(daemon.getState().url, issuesKey(repo())),
        });
      };
      /** The terminal of the agent a button started, at once; a run with no pane opens its page. */
      const show = (
        runId: string | undefined,
        started: Partial<Pick<PlanStarted, "session">> & { readonly paneId?: string },
      ) => {
        const to = shownRoute({ runId, paneId: started.session?.paneId ?? started.paneId });
        if (to) navigate(to);
        else if (runId) openRun(runId);
      };
      const start: BacklogState["start"] = (issue, workflow, allowDirty = false) =>
        act(
          async () => {
            // A plan, or a system plan step (a part made from one), names its own workflow.
            const own = issue.plan !== undefined || issue.step !== undefined;
            const chosen = own && !get().wanted ? undefined : workflow;
            if (!chosen && !own) return NO_WORKFLOW;
            const r = await client().startIssue(
              issue.id,
              { ...(chosen ? { workflow: chosen } : {}), ...(allowDirty ? { allowDirty: true } : {}) },
              repo(),
            );
            if (r.ok && r.data) show(r.data.runId, r.data);
            return r;
          },
          () => void start(issue, workflow, true),
        );
      return {
        ...IDLE,
        picked: undefined,
        routeId,
        wanted: undefined,
        adding: draft !== undefined,
        draft: { ...EMPTY_DRAFT, title: draft?.title ?? "" },
        refs: draft?.refs ?? [],
        showDone: false,
        retry: undefined,

        pick: (id) => set({ picked: id }),
        routeTo: (id) => (id ? set({ routeId: id, picked: undefined }) : set({ routeId: undefined })),
        want: (workflow) => set({ wanted: workflow }),
        openForm: () => set({ adding: true }),
        closeForm: () => set({ adding: false }),
        edit: (field, value) => set((s) => ({ draft: { ...s.draft, [field]: value } })),
        toggleDone: () => set((s) => ({ showDone: !s.showDone })),
        closeNotice: () => set({ notice: undefined, retry: undefined }),

        decide: (issue, decision) => act((by) => client().decideIssue(issue.id, { by, decision }, repo())),
        addAndStart: (issue, workflow) =>
          act(
            async (by) => {
              const d = await client().decideIssue(issue.id, { by, decision: "add" }, repo());
              if (!d.ok) return d;
              if (!workflow) return NO_WORKFLOW;
              return client().startIssue(issue.id, { workflow }, repo());
            },
            () => void start(issue, workflow, true),
          ),
        start,
        analyse: (issue) =>
          act(async (by) => {
            const r = await client().analyzeIssue(issue.id, { by }, repo());
            if (r.ok && r.data) show(r.data.pane.runId, { paneId: r.data.pane.id });
            return r;
          }),
        makePlan: (issue) =>
          act(async (by) => {
            const r = await client().planIssue(issue.id, { by }, repo());
            if (r.ok && r.data) show(r.data.runId, r.data);
            return r;
          }),
        add: async () => {
          const { draft: d, refs } = get();
          const problem = newTaskProblem(d.title);
          if (problem) {
            sayIn(api, problem);
            return false;
          }
          return act(async (by) => {
            const r = await client().addIssue(
              {
                title: d.title.trim(),
                body: d.body,
                priority: d.priority,
                labels: d.labels
                  .split(",")
                  .map((l) => l.trim())
                  .filter((l) => l !== ""),
                refs,
                by,
              },
              repo(),
            );
            if (r.ok) set({ adding: false, draft: EMPTY_DRAFT, ...(r.data ? { picked: r.data.id } : {}) });
            return r;
          });
        },
        finish: async (issue, how) => {
          if (!confirmed(finishQuestion(issue, how))) return false;
          return act((by) =>
            how === "done"
              ? client().closeIssue(issue.id, by, repo())
              : client().dropIssue(issue.id, by, repo()),
          );
        },
      };
    },
);

/** One value of the Backlog's state: the part draws again only when it changed. */
export const useBacklog = <T>(select: (s: BacklogState) => T): T => useScoped(Backlog, select);
/** The store at the moment of an event: no subscription. */
export const useBacklogApi = () => useScopedApi(Backlog);
