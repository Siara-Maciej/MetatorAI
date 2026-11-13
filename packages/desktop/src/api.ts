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
  Issue,
  IssueRef,
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
  PlanBoardView,
  PtyView,
  PullRequestReview,
  Question,
  ResolvedOption,
  ReviewNote,
  ReviewThread,
  RunActivity,
  RunBrief,
  RunChangesView,
  RunMessage,
  RunOverview,
  SplitNode,
  StageProgress,
  StageState,
  Tab,
  UnreadableRun,
  Workspace,
  WorktreeConflict,
} from "@metator/core";

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
  Issue,
  IssueRef,
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
  PlanBoardView,
  Question,
  ResolvedOption,
  ReviewNote,
  RunChangesView,
  RunMessage,
  RunOverview,
  SplitNode,
  StageProgress,
  StageState,
  UnreadableRun,
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
export type ReviewedRequest = PullRequestReview & { readonly id: string };

/** `/state`: one repository, or each repository of a folder. */
export interface RepoState extends Partial<Overview> {
  readonly name: string;
  readonly path: string;
  readonly error?: string;
}
export type StateData = Overview | { readonly folder: string; readonly repos: readonly RepoState[] };

/** A decision of the inbox; in a folder the daemon adds the repository it is in. */
export type InboxItem = CoreInboxItem & { readonly repo?: string };

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

  async post<T>(path: string, body: unknown, repo?: string): Promise<Envelope<T>> {
    try {
      const r = await fetch(this.withRepo(path, repo), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await r.json()) as Envelope<T>;
    } catch (e) {
      return { ok: false, error: { code: "UNREACHABLE", message: (e as Error).message } };
    }
  }

  state = () => this.get<StateData>("/state");
  inbox = () => this.get<{ decisions: InboxItem[] }>("/inbox");
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
  /** An escalated run back at the stage it escalated from, and driven on at once. */
  resume = (runId: string, by: string, repo?: string) =>
    this.post<{ run: { stage: string }; drive?: { started?: boolean; error?: string; hint?: string } }>(
      `/runs/${runId}/resume`,
      { by },
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
  /** Starts (or finds) the terminal session of a run's conductor: the one explicit way a session opens. */
  ptyOpen = (runId: string, repo?: string) => this.post<PtySession>(`/runs/${runId}/pty-open`, {}, repo);
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
  sendMrReplies = (id: string, by: string, repo?: string) =>
    this.post<{ sent: string[] }>(`/mrs/${encodeURIComponent(id)}/send`, { by }, repo);
  resolveMrThread = (id: string, thread: string, by: string, repo?: string) =>
    this.post<ReviewedRequest>(`/mrs/${encodeURIComponent(id)}/resolve`, { by, thread }, repo);
  issues = (repo?: string) => this.get<{ issues: Issue[] }>("/issues", repo);
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
    body: { workflow: string; worktree?: boolean; allowDirty?: boolean },
    repo?: string,
  ) => this.post<{ issue: Issue; runId: string }>(`/issues/${encodeURIComponent(id)}/start`, body, repo);
  closeIssue = (id: string, by: string, repo?: string) =>
    this.post<Issue>(`/issues/${encodeURIComponent(id)}/close`, { by }, repo);
  dropIssue = (id: string, by: string, repo?: string) =>
    this.post<Issue>(`/issues/${encodeURIComponent(id)}/drop`, { by }, repo);
}
