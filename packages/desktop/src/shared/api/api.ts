/**
 * The daemon's JSON and WebSockets, as the app sees them (D7, ADR-0078). These shapes mirror
 * `metator serve`; the app has no domain logic of its own and imports no code from MetatorAI:
 * only types of `@metator/core`, with `import type` (ADR-0085).
 */

import type {
  Attention,
  AttentionCounts,
  BoardStage,
  BoardStep,
  InboxItem as CoreInboxItem,
  DecisionCard,
  DiffLine,
  FileDiff,
  Freshness,
  Implemented,
  Issue,
  IssueDetail,
  IssueRef,
  IssueView,
  LayoutView,
  OptionDescription,
  OptionDiagnostic,
  OptionScope,
  OptionSource,
  OptionsView,
  Overview,
  PaneRole,
  PaneState,
  PaneView,
  Plan,
  PlanBoardView,
  PlanLintProblem,
  PlanLintView,
  PlanStarted,
  PlanStep,
  PtyView,
  PullRequestReview,
  Question,
  ResolvedOption,
  ReviewCard,
  ReviewNote,
  ReviewStatus,
  ReviewThread,
  RunActivity,
  RunArtifact,
  RunArtifactKind,
  RunArtifactText,
  RunBrief,
  RunChangesView,
  RunDriveStarted,
  RunMessage,
  RunOverview,
  RunPlanView,
  SplitNode,
  StageProgress,
  StageState,
  StartedStep,
  SystemDiscoveryView,
  SystemMap,
  SystemMapView,
  SystemPlan,
  SystemPlanStepView,
  SystemPlanSummary,
  SystemPlanView,
  SystemStep,
  Tab,
  Thread,
  UnreadableRun,
  WatchedFinding,
  WatchedReview,
  WorkPhase,
  Workspace,
  WorktreeConflict,
} from "@metator/core";
import type { ScratchDropped } from "../model/stage1.ts";

/*
 * The shapes the daemon passes through unchanged are core's own types (ADR-0085): imported with
 * `import type` only, erased at build, so the app still carries no MetatorAI code. Where the
 * daemon reshapes an answer (`/supervisor`, `/workflows`, `/runs/:id/brief`, the folder's
 * `/state`, the inbox's `repo`), the shape is written here.
 */
export type {
  Attention,
  AttentionCounts,
  BoardStage,
  BoardStep,
  DecisionCard,
  DiffLine,
  FileDiff,
  Freshness,
  Implemented,
  Issue,
  IssueDetail,
  IssueRef,
  IssueView,
  LayoutView,
  OptionDescription,
  OptionDiagnostic,
  OptionScope,
  OptionSource,
  OptionsView,
  Overview,
  PaneRole,
  PaneState,
  PaneView,
  Plan,
  PlanBoardView,
  PlanLintProblem,
  PlanLintView,
  PlanStarted,
  PlanStep,
  Question,
  ResolvedOption,
  ReviewNote,
  RunArtifact,
  RunArtifactKind,
  RunArtifactText,
  RunChangesView,
  RunDriveStarted,
  RunMessage,
  RunOverview,
  RunPlanView,
  SplitNode,
  StageProgress,
  StageState,
  StartedStep,
  SystemDiscoveryView,
  SystemMap,
  SystemMapView,
  SystemPlan,
  SystemPlanStepView,
  SystemPlanSummary,
  SystemPlanView,
  SystemStep,
  Thread,
  UnreadableRun,
  WorkPhase,
};

/** One option of a question. */
export type QuestionOption = Question["options"][number];
/** An event of a run's activity. */
export type Activity = RunActivity;
/** A live terminal of a pane, as the daemon's broker describes it. */
export type PtySession = PtyView;
export type TabView = Tab;
export type WorkspaceView = Workspace;
/** Two runs that changed the same files, and which to merge first. */
export type Conflict = WorktreeConflict;
/** One review thread on my request, with what the agent made of it. */
export type ReviewThreadView = ReviewThread;
/** My reviewed request, by the id `metator mrs` names it. */
export type ReviewedRequest = PullRequestReview & {
  readonly id: string;
  /** Round 18: open threads not triaged yet (a new review: Analyse on Home). */
  readonly fresh?: number | undefined;
};

/** A finding of a watched review (WatchedReview v1, round 18): its state is the agent's, with why. */
/** A watched MR's one state word, as the daemon decides it (round 18). */
export type { ReviewStatus, WatchedFinding };

/**
 * A watched MR (others'), as `GET /reviews` lists it (round 18): the WatchedReview document with its
 * status, its findings counted by state and its last review run. `repo` is the code host's
 * `owner/name`, not the folder's repository.
 */
export type ReviewView = WatchedReview & {
  readonly status: ReviewStatus;
  readonly counts: {
    readonly open: number;
    readonly fixed: number;
    readonly notFixed: number;
    readonly disputed: number;
    readonly outdated: number;
  };
  readonly run?: { readonly runId: string; readonly status: string; readonly stage: string } | undefined;
  /** In a folder: the repository whose `.metator/reviews/` holds it (`repo` stays the code host's). */
  readonly localRepo?: string | undefined;
};

/**
 * A card of a review on Home (round 18), composed by the daemon (`/inbox` `reviews`): its words and
 * its buttons, each a request the app sends with the person's name; its repository in a folder.
 */
export type ReviewCardView = ReviewCard & { readonly repo?: string | undefined };

/** `/inbox`: the runs' decisions, the questions of panes without a run, the reviews' cards (round 18). */
export interface InboxData {
  readonly decisions: InboxItem[];
  readonly panes?: PaneAsk[];
  readonly reviews?: ReviewCardView[];
}

/** What a button that starts a review's agent answers: its run and its pane (round 18). */
export interface ReviewStarted {
  readonly runId?: string | undefined;
  readonly session?: { readonly paneId: string; readonly host?: string | undefined } | undefined;
  readonly pane?: { readonly id: string; readonly runId?: string | undefined } | undefined;
  readonly noSession?: string | undefined;
}

/** `/state`: one repository, or each repository of a folder. */
export interface RepoState extends Partial<Overview> {
  readonly name: string;
  readonly path: string;
  readonly error?: string;
  /** A worktree checkout (`git worktree add`): the repository it is one of, and its branch. */
  readonly worktreeOf?: string;
  readonly branch?: string;
}
export type StateData = Overview | { readonly folder: string; readonly repos: readonly RepoState[] };

/** A decision of the inbox; in a folder the daemon adds the repository it is in. */
export type InboxItem = CoreInboxItem & { readonly repo?: string };

/**
 * A question of a pane without a run (ADR-0091), from `/inbox`'s `panes`: the intake chat's host
 * asks leave to run a command, or its agent asks in words. Answered with `answerPane`.
 */
/** Why a pane's host is not running although its work is not over (round 11): it can be continued. */
export interface PanePaused {
  readonly at: string;
  readonly why: "daemon-stopped" | "process-lost";
}

/** What `POST /runs/:run/continue` did. */
export interface ContinueResult {
  readonly resumed: readonly {
    readonly repo?: string;
    readonly paneId: string;
    readonly role: string;
    readonly sessionId?: string;
  }[];
  readonly drives: readonly { readonly repo?: string; readonly runId: string; readonly host: string }[];
  readonly skipped: readonly {
    readonly repo?: string;
    readonly paneId?: string;
    readonly runId?: string;
    readonly why: string;
  }[];
}

export type { ScratchDropped } from "../model/stage1.ts";

export interface PaneAsk {
  readonly kind: "pane";
  /** The repository, when the daemon serves a folder. */
  readonly repo?: string;
  readonly paneId: string;
  /** The run of the pane, when the agent that asks works for one (an agent's question in words). */
  readonly runId?: string;
  /** The pane's label (`chat`). */
  readonly label: string;
  readonly role?: string;
  readonly host: string;
  readonly question: {
    readonly id: string;
    readonly paneId: string;
    readonly source: "agent" | "permission";
    readonly agent: string;
    readonly prompt: string;
    /** An agent's question in words: its whole message (the card shows it expanded on a click). */
    readonly text?: string;
    /** A host's permission prompt: the whole command. */
    readonly command?: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
    readonly askedAt: string;
  };
}

/** A thread's current chat terminal (the last of its `panes`) and whether it runs. */
export interface ChatLink {
  readonly paneId: string;
  readonly repo?: string;
  readonly status: "live" | "paused" | "ended" | "missing";
}

/** A top run of a thread, as `GET /threads` lists it. */
export interface TaskLink {
  readonly runId: string;
  readonly repo?: string;
  readonly task: string;
  readonly status: string;
  readonly stage: string;
  readonly attention: Attention;
  readonly updatedAt: string;
  readonly children?: readonly string[];
}

/**
 * A thread (round 16, ADR-0095) as `GET /threads` gives it: the document (`Thread` v1, one topic
 * with its chat terminal, the runs started in it, what the daemon noted of them) with its
 * repository (in a folder), its chat and its tasks.
 */
export type ThreadView = Thread & {
  readonly repo?: string;
  readonly chat?: ChatLink;
  readonly tasks?: readonly TaskLink[];
  readonly attention?: Attention;
};

/** `GET /threads`: the open threads, the closed ones, and the top runs no thread lists. */
export interface ThreadsView {
  readonly threads: readonly ThreadView[];
  readonly closed: readonly ThreadView[];
  readonly withoutChat: readonly TaskLink[];
}

/** `POST /issues/:id/analyze`: the item and the mt-guide pane told to analyse it (round 17). */
export interface AnalyzeStarted {
  readonly issue: IssueView;
  readonly pane: PaneView;
}

/** `POST /issues/from-plan`: the parent item and its children. */
export interface FromPlan {
  readonly parent: Issue;
  readonly children: readonly Issue[];
}

/** `/runs/:id/brief`: the run's brief with where the run stands. */
export type Brief = RunBrief & { readonly runId: string; readonly status: string; readonly stage: string };

export interface SupervisorView {
  readonly daemon: {
    readonly pid: number;
    readonly uptimeMs: number;
    readonly url: string;
    readonly superviseMs: number;
    readonly folder: string | null;
    readonly repo: string | null;
  };
  readonly hosts: readonly string[];
  /** The repository's conversation agent (`mt-chat`), when it has one: what a new chat opens (round 13). */
  readonly chatAgent?: string;
  /** Each host with the program it starts and whether it is on the daemon's machine (absent on an older daemon). */
  readonly hostStatus?: readonly {
    readonly id: string;
    readonly command?: string;
    readonly installed: boolean;
  }[];
  readonly policy: {
    readonly wipLimit: number;
    readonly respawn: { readonly enabled: boolean; readonly maxAttempts: number };
    readonly idleThresholdMs: number;
    readonly hostOrder: readonly string[];
    readonly chatApprovals: string;
  };
  readonly sessions: readonly PtySession[];
  readonly acceptance: {
    readonly since: string;
    readonly answered: number;
    readonly medianAnswerMs?: number;
    readonly fromInbox: number;
    readonly restarts: number;
    readonly nudges: number;
  };
}

export interface Workflow {
  readonly id: string;
  readonly revision: number;
  readonly description?: string;
  /** The autonomy levels the workflow runs at; a daemon older than this field leaves it out. */
  readonly autonomy?: readonly string[];
  readonly stages: readonly string[];
  readonly source: string;
}

export interface Envelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    /** What a refusal is about, for the app to act on (`check: "tree"`: uncommitted changes). */
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export const DEFAULT_DAEMON = "http://127.0.0.1:4310";

/** Where the daemon is: `?daemon=`, then what the person saved, then the default port. */
export function daemonUrl(search: string, saved: string | null): string {
  const given = new URLSearchParams(search).get("daemon");
  return (given ?? saved ?? DEFAULT_DAEMON).replace(/\/+$/, "");
}

export const wsUrl = (base: string, path: string): string => `${base.replace(/^http/, "ws")}${path}`;

export class DaemonClient {
  constructor(readonly base: string) {}

  private withRepo(path: string, repo?: string): string {
    if (!repo) return `${this.base}${path}`;
    const sep = path.includes("?") ? "&" : "?";
    return `${this.base}${path}${sep}repo=${encodeURIComponent(repo)}`;
  }

  async get<T>(path: string, repo?: string): Promise<Envelope<T>> {
    try {
      const r = await fetch(this.withRepo(path, repo));
      return (await r.json()) as Envelope<T>;
    } catch (e) {
      return { ok: false, error: { code: "UNREACHABLE", message: (e as Error).message } };
    }
  }

  async post<T>(
    path: string,
    body: unknown,
    repo?: string,
    method: "POST" | "PUT" = "POST",
  ): Promise<Envelope<T>> {
    try {
      const r = await fetch(this.withRepo(path, repo), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await r.json()) as Envelope<T>;
    } catch (e) {
      return { ok: false, error: { code: "UNREACHABLE", message: (e as Error).message } };
    }
  }

  state = () => this.get<StateData>("/state");
  inbox = () => this.get<InboxData>("/inbox");
  supervisor = (repo?: string) => this.get<SupervisorView>("/supervisor", repo);
  workflows = (repo?: string) => this.get<{ workflows: Workflow[] }>("/workflows", repo);
  options = (repo?: string) => this.get<OptionsView>("/options", repo);
  setOption = (
    key: string,
    body: { scope: OptionScope; value?: unknown; reset?: boolean; runId?: string },
    repo?: string,
  ) => this.post<ResolvedOption>(`/options/${encodeURIComponent(key)}`, body, repo);
  conflicts = (repo?: string) => this.get<{ conflicts: Conflict[] }>("/conflicts", repo);
  activity = (runId: string, repo?: string, tail?: number) =>
    this.get<{ entries: Activity[] }>(`/runs/${runId}/activity${tail ? `?tail=${tail}` : ""}`, repo);
  messages = (runId: string, repo?: string) =>
    this.get<{ messages: RunMessage[] }>(`/runs/${runId}/messages`, repo);
  board = (runId: string, repo?: string) => this.get<PlanBoardView>(`/runs/${runId}/board`, repo);
  brief = (runId: string, repo?: string, since?: string) =>
    this.get<Brief>(`/runs/${runId}/brief${since ? `?since=${encodeURIComponent(since)}` : ""}`, repo);
  seen = (runId: string, repo?: string) => this.post<{ at: string }>(`/runs/${runId}/seen`, {}, repo);
  /**
   * A task started again (round 11): every paused pane of the run and its descendants resumed,
   * every active run nothing drives given its session or drive back; what was skipped and why.
   */
  continueRun = (runId: string, by: string, repo?: string) =>
    this.post<ContinueResult>(`/runs/${runId}/continue`, { by }, repo);
  /** The repository's debug changes (round 13): edits not meant for a commit, recorded as patches. */
  scratch = (repo?: string) => this.get<{ items?: unknown[]; gone?: unknown[] }>("/scratch", repo);
  /** Dismisses debug changes without touching a file (a `changed` one the person deals with by hand). */
  forgetScratch = (body: { ids: readonly string[]; by: string }, repo?: string) =>
    this.post<{ forgotten?: { id: string; files?: string[] }[] }>("/scratch/forget", body, repo);
  /** Reverse-applies debug changes (all without `ids`); a patch that no longer applies is reported. */
  dropScratch = (body: { ids?: readonly string[]; by: string }, repo?: string) =>
    this.post<ScratchDropped>("/scratch/drop", body, repo);
  /** One paused pane started again in place (refused when it is not paused). */
  continuePane = (paneId: string, by: string, repo?: string) =>
    this.post<ContinueResult>(`/panes/${encodeURIComponent(paneId)}/continue`, { by }, repo);
  /**
   * An escalated run back at the stage it escalated from, or at `to`, with a note for the next
   * agent; driven on at once.
   */
  resume = (
    runId: string,
    by: string,
    repo?: string,
    back: { readonly to?: string | undefined; readonly note?: string | undefined } = {},
  ) =>
    this.post<{ run: { stage: string }; drive?: { started?: boolean; error?: string; hint?: string } }>(
      `/runs/${runId}/resume`,
      { by, ...(back.to ? { to: back.to } : {}), ...(back.note?.trim() ? { note: back.note.trim() } : {}) },
      repo,
    );
  /** Ends a run as aborted, with the reason: its drive is stopped and its panes are closed. */
  abort = (runId: string, reason: string, repo?: string) =>
    this.post<{ status: string }>(`/runs/${runId}/close`, { aborted: true, reason }, repo);
  attach = (runId: string, by: string, repo?: string) => this.post(`/runs/${runId}/attach`, { by }, repo);
  release = (runId: string, repo?: string) => this.post(`/runs/${runId}/release`, {}, repo);
  /** An answer to a question; `origin: "inbox"` only from the decision card (acceptance 11a counts it). */
  answer = (
    input: {
      readonly runId: string;
      readonly question: string;
      readonly choices: readonly string[];
      readonly by: string;
      readonly text?: string | undefined;
      readonly origin?: "inbox" | undefined;
    },
    repo?: string,
  ) =>
    this.post<Question>(
      `/runs/${input.runId}/answer`,
      {
        question: input.question,
        choices: input.choices,
        by: input.by,
        ...(input.text ? { text: input.text } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      },
      repo,
    );
  /** An answer to a pane's question: typed into the pane at once (a menu's number, the agent's words). */
  answerPane = (
    input: {
      readonly paneId: string;
      readonly question: string;
      readonly choices: readonly string[];
      readonly by: string;
      readonly text?: string | undefined;
    },
    repo?: string,
  ) =>
    this.post<PaneAsk["question"]>(
      `/panes/${encodeURIComponent(input.paneId)}/answer`,
      {
        question: input.question,
        choices: input.choices,
        by: input.by,
        ...(input.text ? { text: input.text } : {}),
      },
      repo,
    );
  /** Starts (or finds) the terminal session of a run's conductor: the one explicit way a session opens. */
  ptyOpen = (runId: string, repo?: string) => this.post<PtySession>(`/runs/${runId}/pty-open`, {}, repo);
  /** Starts the run's conductor: the agent that drives the run in a pane of its own (the app's "Open a session"). */
  start = (runId: string, body: { by: string; host?: string | undefined }, repo?: string) =>
    this.post<PaneView>(`/runs/${runId}/start`, body, repo);
  /** Drives the run in the background, with no terminal (`metator run drive --detach`). */
  drive = (runId: string, body: { by: string; host?: string | undefined }, repo?: string) =>
    this.post<RunDriveStarted>(`/runs/${runId}/drive`, body, repo);
  /** The run's implementation plan with its lint, and what changed since the planner's previous version. */
  runPlan = (runId: string, repo?: string) => this.get<RunPlanView>(`/runs/${runId}/plan`, repo);
  systemPlans = (repo?: string) => this.get<SystemPlanSummary[]>("/system/plans", repo);
  systemPlan = (id: string, repo?: string) =>
    this.get<SystemPlanView>(`/system/plans/${encodeURIComponent(id)}`, repo);
  approveSystemPlan = (id: string, by: string, repo?: string) =>
    this.post<SystemPlanView>(`/system/plans/${encodeURIComponent(id)}/approve`, { by }, repo);
  /** "Retry this step": a step whose child run was aborted is pending again; the system run starts a new child. */
  retrySystemStep = (id: string, step: string, by: string, repo?: string) =>
    this.post<unknown>(
      `/system/plans/${encodeURIComponent(id)}/steps/${encodeURIComponent(step)}/retry`,
      { by },
      repo,
    );
  systemMap = (repo?: string) => this.get<SystemMapView>("/system/map", repo);
  saveSystemMap = (body: { map: unknown; digest: string | null; by: string }, repo?: string) =>
    this.post<SystemMapView>("/system/map", body, repo, "PUT");
  discover = (body: { write: boolean; by?: string | undefined }, repo?: string) =>
    this.post<SystemDiscoveryView>("/system/discover", body, repo);
  artifacts = (runId: string, repo?: string) => this.get<RunArtifact[]>(`/runs/${runId}/artifacts`, repo);
  artifact = (runId: string, name: string, repo?: string) =>
    this.get<RunArtifactText>(
      `/runs/${runId}/artifacts/${name.split("/").map(encodeURIComponent).join("/")}`,
      repo,
    );
  message = (
    to: string,
    from: string,
    topic: RunMessage["topic"],
    text: string,
    refs: string[],
    by: string,
    repo?: string,
  ) => this.post<RunMessage>(`/runs/${to}/message`, { from, topic, text, refs, by }, repo);
  createRun = (
    input: {
      workflow: string;
      task: string;
      autonomy?: string;
      worktree?: boolean;
      parent?: string;
      drive?: string;
      /** Start the worktree from the last commit although tracked files changed. */
      allowDirty?: boolean;
    },
    repo?: string,
  ) => this.post<{ run: { runId: string }; drive?: { error?: string } }>("/runs", input, repo);
  layout = (repo?: string) => this.get<LayoutView>("/layout", repo);
  /** The threads (round 16), open and closed, of every repository the daemon serves. */
  threads = () => this.get<ThreadsView>("/threads");
  /**
   * A new thread and its chat terminal (the conversation agent in a pane of its own); with no
   * title it is "New chat" until the agent names it.
   */
  newThread = (body: { title?: string; by: string; host?: string }, repo?: string) =>
    this.post<{ thread: Thread; pane: PaneView }>("/threads", body, repo);
  /** Ends the thread's chat terminal; its runs go on. */
  closeThread = (id: string, by: string, repo?: string) =>
    this.post<{ thread: Thread; ended?: string }>(`/threads/${encodeURIComponent(id)}/close`, { by }, repo);
  /** The thread's chat running again: resumed, or a new session told to carry on. */
  reopenThread = (id: string, by: string, repo?: string) =>
    this.post<{ thread: Thread; pane: PaneView; how: "live" | "resumed" | "new-session" }>(
      `/threads/${encodeURIComponent(id)}/reopen`,
      { by },
      repo,
    );
  openPane = (
    input: {
      runId?: string;
      workspace?: string;
      /** An existing tab of the workspace; `newTab` opens a fresh one named `label` instead. */
      tab?: string;
      newTab?: boolean;
      role: PaneRole;
      label?: string;
      argv?: string[];
      host?: string;
      agent?: string;
      prompt?: string;
    },
    repo?: string,
  ) => this.post<PaneView>("/panes", input, repo);
  closePane = (paneId: string, repo?: string) =>
    this.post<{ closed: boolean }>(`/panes/${encodeURIComponent(paneId)}/close`, {}, repo);
  splitPane = (paneId: string, dir: "right" | "down", repo?: string, argv?: string[]) =>
    this.post<PaneView>(
      `/panes/${encodeURIComponent(paneId)}/split`,
      { dir, ...(argv ? { argv } : {}) },
      repo,
    );
  setTree = (tabId: string, tree: SplitNode, repo?: string) =>
    this.post<TabView>(`/tabs/${encodeURIComponent(tabId)}/tree`, { tree }, repo);
  closeWorkspace = (workspace: string, repo?: string) =>
    this.post<{ closed: number }>(`/workspaces/${encodeURIComponent(workspace)}/close`, {}, repo);
  openEditor = (runId: string, body: { file?: string; line?: number } = {}, repo?: string) =>
    this.post<{ argv: string[]; dir: string }>(`/runs/${runId}/open-editor`, body, repo);
  openPaneEditor = (paneId: string, repo?: string) =>
    this.post<{ argv: string[]; dir: string }>(`/panes/${encodeURIComponent(paneId)}/open-editor`, {}, repo);
  reviewChanges = (runId: string, file?: string, repo?: string) =>
    this.get<RunChangesView>(`/runs/${runId}/review${file ? `?file=${encodeURIComponent(file)}` : ""}`, repo);
  reviewNotes = (runId: string, repo?: string) =>
    this.get<{ runId: string; notes: ReviewNote[] }>(`/runs/${runId}/review-notes`, repo);
  addNote = (
    runId: string,
    body: { file?: string; line?: number; side?: "old" | "new"; text: string; by: string },
    repo?: string,
  ) => this.post<ReviewNote>(`/runs/${runId}/review-notes`, body, repo);
  sendNotes = (runId: string, by: string, repo?: string) =>
    this.post<{ message: RunMessage; notes: ReviewNote[] }>(`/runs/${runId}/review-send`, { by }, repo);
  setNoteStatus = (runId: string, id: string, status: ReviewNote["status"], repo?: string) =>
    this.post<ReviewNote>(`/runs/${runId}/review-note-status`, { id, status }, repo);
  /** Reviews of my open requests (T3): one entry per request with its threads. */
  mrs = (repo?: string) => this.get<{ requests: ReviewedRequest[] }>("/mrs", repo);
  /** Sends the proposed replies: those named in `only` (round 18), or all. */
  sendMrReplies = (id: string, by: string, repo?: string, only?: readonly string[]) =>
    this.post<{ sent: string[] }>(
      `/mrs/${encodeURIComponent(id)}/send`,
      { by, ...(only ? { only } : {}) },
      repo,
    );
  /** "Analyse" a new review on my MR: the responder in a visible pane (round 18). */
  analyseMr = (id: string, by: string, repo?: string) =>
    this.post<ReviewStarted>(`/mrs/${encodeURIComponent(id)}/analyse`, { by }, repo);
  /** The watched MRs (others'), with their findings and what is new, and their cards (round 18). */
  reviews = (repo?: string) =>
    this.get<{ reviews: ReviewView[]; cards?: ReviewCardView[] }>("/reviews", repo);
  /** "Review" of a requested review: a review of the MR from its link, in a visible pane. */
  startReview = (url: string, by: string, repo?: string) =>
    this.post<ReviewStarted>("/reviews", { url, by }, repo);
  rereview = (id: string, by: string, repo?: string) =>
    this.post<ReviewStarted>(`/reviews/${encodeURIComponent(id)}/rereview`, { by }, repo);
  unwatchReview = (id: string, by: string, repo?: string) =>
    this.post<{ review: ReviewView }>(`/reviews/${encodeURIComponent(id)}/unwatch`, { by }, repo);
  /**
   * A card's button: the request the daemon put on it, with the person's name. Its path names the
   * card's repository already (in a folder, `?repo=`).
   */
  cardAction = (path: string, body: object) => this.post<ReviewStarted>(path, body);
  resolveMrThread = (id: string, thread: string, by: string, repo?: string) =>
    this.post<ReviewedRequest>(`/mrs/${encodeURIComponent(id)}/resolve`, { by, thread }, repo);
  issues = (repo?: string) => this.get<{ issues: IssueView[] }>("/issues", repo);
  addIssue = (
    body: {
      title: string;
      body?: string;
      priority?: Issue["priority"];
      labels?: readonly string[];
      refs?: readonly IssueRef[];
      by: string;
    },
    repo?: string,
  ) => this.post<Issue>("/issues", body, repo);
  decideIssue = (id: string, body: { by: string; decision: "add" | "drop" }, repo?: string) =>
    this.post<Issue>(`/issues/${encodeURIComponent(id)}/decide`, body, repo);
  startIssue = (
    id: string,
    body: { workflow?: string; worktree?: boolean; allowDirty?: boolean },
    repo?: string,
  ) => this.post<Implemented>(`/issues/${encodeURIComponent(id)}/start`, body, repo);
  /**
   * "Analyse" / "Re-analyse" (round 17): an mt-guide pane told to analyse the item and record it
   * (`metator issue analyze --issue <id>`); the app shows that pane.
   */
  analyzeIssue = (id: string, body: { by: string; host?: string | undefined }, repo?: string) =>
    this.post<AnalyzeStarted>(`/issues/${encodeURIComponent(id)}/analyze`, body, repo);
  /**
   * "Make plan": a run of the item's workflow `--until plan` with its conductor in a pane of its
   * own; refused while the analysis is stale.
   */
  planIssue = (id: string, body: { by: string; host?: string | undefined }, repo?: string) =>
    this.post<PlanStarted>(`/issues/${encodeURIComponent(id)}/plan`, body, repo);
  /** One item with its analysis text and its plan in short. */
  issue = (id: string, repo?: string) => this.get<IssueDetail>(`/issues/${encodeURIComponent(id)}`, repo);
  /** "Create Backlog item" from a plan run or a system run: one parent, and a child per step or phase. */
  issueFromPlan = (body: { runId: string; by: string }, repo?: string) =>
    this.post<FromPlan>("/issues/from-plan", body, repo);
  /** "Plan this step": the step's child run `--until plan` in its app's repository, in a visible pane. */
  planSystemStep = (
    plan: string,
    step: string,
    body: { by: string; runId?: string | undefined; host?: string | undefined },
    repo?: string,
  ) =>
    this.post<StartedStep>(
      `/system/plans/${encodeURIComponent(plan)}/steps/${encodeURIComponent(step)}/plan`,
      body,
      repo,
    );
  closeIssue = (id: string, by: string, repo?: string) =>
    this.post<Issue>(`/issues/${encodeURIComponent(id)}/close`, { by }, repo);
  dropIssue = (id: string, by: string, repo?: string) =>
    this.post<Issue>(`/issues/${encodeURIComponent(id)}/drop`, { by }, repo);
}
