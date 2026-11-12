/**
 * The daemon's JSON and WebSockets, as the app sees them (D7, ADR-0078). These shapes mirror
 * `metator serve`; the app has no domain logic of its own and imports nothing from MetatorAI.
 */

export type Attention = "you" | "driving" | "stopped" | "done" | "escalated" | "aborted";
export type StageState = "done" | "current" | "waiting" | "next" | "stopped";

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface DecisionCard {
  readonly task: string;
  readonly done: readonly string[];
  readonly artifacts: readonly string[];
  readonly recommended?: string;
  readonly reversible: boolean;
  readonly soFar?: readonly string[];
  readonly evidence?: readonly string[];
  readonly consequences?: Readonly<Record<string, string>>;
  readonly blastRadius?: { readonly files: number; readonly areas: readonly string[] };
  readonly costOfDelay?: readonly string[];
  readonly group?: { readonly parent: string; readonly step: number; readonly of: number };
}

export interface Question {
  readonly id: string;
  readonly runId: string;
  readonly stage: string;
  readonly source: "gate" | "agent" | "permission";
  readonly agent?: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly askedAt: string;
  readonly answer?: {
    readonly choices: readonly string[];
    readonly text?: string;
    readonly by: string;
    readonly at: string;
  };
  readonly card?: DecisionCard;
}

export interface StageProgress {
  readonly id: string;
  readonly state: StageState;
  readonly hitl: boolean;
}

export interface RunOverview {
  readonly runId: string;
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: string;
  readonly status: string;
  readonly stage: string;
  /** Why an escalated or aborted run stopped. */
  readonly reason?: string;
  readonly attention: Attention;
  readonly stages: readonly StageProgress[];
  readonly questions: readonly Question[];
  readonly driving: boolean;
  readonly driver: "agent" | "human";
  readonly attachedBy?: string;
  readonly died: boolean;
  readonly parent?: string;
  readonly children?: readonly string[];
  readonly host?: string;
  readonly last?: {
    readonly at: string;
    readonly type: string;
    readonly text: string;
    readonly stage?: string;
    readonly agent?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly worktree?: {
    readonly id: string;
    readonly path: string;
    readonly branch: string;
    readonly ports?: { readonly from: number; readonly count: number };
  };
  readonly services: readonly {
    readonly service: string;
    readonly status: string;
    readonly ports: readonly number[];
    readonly scope: string;
  }[];
}

export interface AttentionCounts {
  readonly you: number;
  readonly driving: number;
  readonly stopped: number;
  readonly escalated: number;
  readonly finished: number;
  readonly questions: number;
  readonly services: number;
}

export interface Overview {
  readonly runs: readonly RunOverview[];
  readonly conversations: readonly {
    readonly id: string;
    readonly title: string;
    readonly host: string;
    readonly turns: number;
    readonly updatedAt: string;
  }[];
  readonly counts: AttentionCounts;
}

/** `/state`: one repository, or each repository of a folder. */
export interface RepoState extends Partial<Overview> {
  readonly name: string;
  readonly path: string;
  readonly error?: string;
}
export type StateData = Overview | { readonly folder: string; readonly repos: readonly RepoState[] };

export interface InboxItem {
  readonly repo?: string;
  readonly runId: string;
  readonly task: string;
  readonly stage: string;
  readonly driving: boolean;
  readonly waitedMs: number;
  readonly question: Question;
}

export interface Activity {
  readonly at: string;
  readonly type: string;
  readonly stage?: string;
  readonly agent?: string;
  readonly text: string;
  readonly origin?: "hook" | "pty" | "run" | "inbox";
}

export interface RunMessage {
  readonly id: string;
  readonly fromRun: string;
  readonly toRun: string;
  readonly at: string;
  readonly topic: "info" | "contract" | "shared-file" | "done" | "review" | "review-reply";
  readonly text: string;
  readonly refs: readonly string[];
  readonly by: string;
}

export interface Conflict {
  readonly runs: readonly [string, string];
  readonly files: readonly string[];
  readonly mergeFirst: string;
}

/** A live terminal of a pane, as the daemon's broker describes it (core's `PtyView`). */
export interface PtySession {
  readonly paneId: string;
  /** The run the pane belongs to; a pane of no run (a shell of the repository) has none. */
  readonly runId?: string;
  readonly role: PaneRole;
  readonly host: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly exitCode?: number;
  readonly idle: boolean;
  readonly lastOutputAt: string;
  readonly lastHookAt?: string;
}

/** A pane's agent state as the daemon senses it (R3). */
export type PaneState = "working" | "blocked" | "waiting" | "idle" | "exited";
export type PaneRole = "conductor" | "worker" | "apps" | "gate" | "shell";

/** A pane of the daemon's layout (R1): what it runs, and its live terminal and state when it has one. */
export interface PaneView {
  readonly id: string;
  readonly workspace: string;
  readonly tab: string;
  readonly role: PaneRole;
  readonly label: string;
  readonly cwd: string;
  readonly runId?: string;
  readonly worker?: { readonly name: string; readonly stage: string };
  readonly process:
    | {
        readonly kind: "host";
        readonly host: string;
        readonly agent: string;
        readonly prompt: string;
        readonly sessionId?: string;
      }
    | { readonly kind: "command"; readonly argv: readonly string[] };
  readonly live?: PtySession;
  readonly state?: { readonly state: PaneState; readonly reason: string };
}

/** A tab's split tree (S6): a pane, or two parts along a direction at a ratio. */
export type SplitNode =
  | { readonly pane: string }
  | { readonly dir: "row" | "column"; readonly ratio: number; readonly a: SplitNode; readonly b: SplitNode };

export interface TabView {
  readonly id: string;
  readonly label: string;
  readonly panes: readonly string[];
  readonly tree?: SplitNode;
}

export interface WorkspaceView {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly runId?: string;
  readonly group?: string;
  readonly tabs: readonly TabView[];
}

export interface LayoutView {
  readonly workspaces: readonly WorkspaceView[];
  readonly panes: readonly PaneView[];
}

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

/** Options (S1): what `/options` says about every setting. */
export type OptionScope = "user" | "repo" | "run";
export type OptionSource = OptionScope | "default";
export interface OptionDescription {
  readonly key: string;
  readonly kind: "boolean" | "enum" | "number" | "string" | "list" | "keybinding" | "command";
  readonly scope: "user" | "repo";
  readonly title: string;
  readonly description: string;
  readonly default: unknown;
  readonly restart: "none" | "daemon" | "app";
  readonly since?: string;
  readonly fixed: boolean;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  readonly runsLocally?: boolean;
}
export interface ResolvedOption {
  readonly key: string;
  readonly value: unknown;
  readonly source: OptionSource;
  readonly definition: OptionDescription;
  readonly layers: Partial<Record<OptionScope, unknown>>;
}
export interface OptionDiagnostic {
  readonly kind: "unknown-key" | "invalid-value" | "wrong-scope" | "fixed";
  readonly scope: OptionScope;
  readonly source: string;
  readonly key: string;
  readonly message: string;
}
export interface OptionsView {
  readonly options: readonly ResolvedOption[];
  readonly diagnostics: readonly OptionDiagnostic[];
  readonly groups: readonly { readonly id: string; readonly count: number; readonly changed: number }[];
  readonly files: { readonly user: string; readonly repo: string; readonly run?: string };
}

/** The plan board (S2): where a run stands and what is left, from `GET /runs/:id/board`. */
export interface BoardStep {
  readonly id: string;
  readonly action: "create" | "modify" | "delete";
  readonly path: string;
  readonly intent: string;
  readonly state: "todo" | "in-progress" | "done" | "blocked";
  readonly testsFirst: readonly string[];
  readonly rules: readonly string[];
  readonly exemplar?: string;
  readonly dependsOn: readonly string[];
  readonly worker?: { readonly name: string; readonly paneId?: string };
  readonly evidence?: string;
}
export interface BoardStage extends StageProgress {
  readonly owners: readonly string[];
  readonly workedBy: readonly string[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly verdict?: string;
}
/** A backlog task (Issue v1): proposed by an agent, or added by a person. */
export interface IssueRef {
  readonly run?: string;
  readonly step?: string;
  readonly file?: string;
  readonly line?: number;
  readonly note?: string;
}
/** One review thread on my request, with what the agent made of it. */
export interface ReviewThreadView {
  readonly id: string;
  readonly author: string;
  readonly file?: string;
  readonly line?: number;
  readonly body: string;
  readonly kind: "unsorted" | "question" | "change" | "nit" | "praise";
  readonly state: "open" | "answered" | "planned" | "fixed" | "resolved";
  readonly reply?: string;
  readonly repliedAt?: string;
}

/** My reviewed request (`PullRequestReview`), by the id `metator mrs` names it. */
export interface ReviewedRequest {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly branch?: string;
  readonly url?: string;
  readonly threads: readonly ReviewThreadView[];
  readonly runId?: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: "proposed" | "open" | "in-progress" | "done" | "dropped";
  readonly priority: "low" | "normal" | "high";
  readonly labels: readonly string[];
  readonly refs: readonly IssueRef[];
  readonly proposedBy?: {
    readonly agent: string;
    readonly runId?: string;
    readonly at: string;
    readonly questionId?: string;
  };
  readonly decidedBy?: { readonly by: string; readonly at: string; readonly decision: "added" | "dropped" };
  readonly runId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** A person's note on a run's change (ReviewNotes v1). */
export interface ReviewNote {
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
  readonly side?: "old" | "new";
  readonly text: string;
  readonly by: string;
  readonly at: string;
  readonly status: "draft" | "sent" | "addressed";
  readonly sentIn?: string;
}
export interface DiffLine {
  readonly kind: "context" | "add" | "del";
  readonly old?: number;
  readonly new?: number;
  readonly text: string;
}
export interface FileDiff {
  readonly path: string;
  readonly status: "modified" | "added" | "deleted" | "renamed";
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly { readonly header: string; readonly lines: readonly DiffLine[] }[];
}
export interface RunChangesView {
  readonly runId: string;
  readonly dir: string;
  readonly base: string;
  readonly files: readonly {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
    readonly status: FileDiff["status"];
  }[];
  readonly diff?: FileDiff;
}
export interface PlanBoardView {
  readonly runId: string;
  readonly task: string;
  readonly workflow: string;
  readonly status: string;
  readonly stage: string;
  readonly stages: readonly BoardStage[];
  readonly plan?: {
    readonly scope: readonly string[];
    readonly steps: readonly BoardStep[];
    readonly done: number;
  };
  readonly workers: readonly {
    readonly name: string;
    readonly stage: string;
    readonly agent: string;
    readonly paneId: string;
    readonly alive: boolean;
    readonly state?: string;
    readonly result?: { readonly status: string; readonly summary: string; readonly at: string };
  }[];
  readonly waiting: readonly Question[];
  readonly artifacts: readonly {
    readonly name: string;
    readonly present: boolean;
    readonly stage?: string;
  }[];
  readonly gates: readonly {
    readonly gate: string;
    readonly passed: boolean;
    readonly at: string;
    readonly steps: readonly { readonly id: string; readonly ok: boolean }[];
  }[];
  readonly next: readonly { readonly id: string; readonly owners: readonly string[] }[];
  readonly timeline: readonly Activity[];
}

export interface Brief {
  readonly runId: string;
  readonly status: string;
  readonly stage: string;
  readonly since: string;
  readonly transitions: readonly string[];
  readonly files: readonly string[];
  readonly answers: readonly string[];
  readonly questions: readonly string[];
  readonly errors: readonly string[];
  readonly tools: number;
  readonly last?: string;
}

export interface Workflow {
  readonly id: string;
  readonly revision: number;
  readonly description?: string;
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
  /** Stops the process that drives the run; the run stays where it is. */
  stop = (runId: string, repo?: string) =>
    this.post<{ stopped: number | null }>(`/runs/${runId}/stop`, {}, repo);
  /** Ends a run as aborted, with the reason: its drive is stopped and its panes are closed. */
  abort = (runId: string, reason: string, repo?: string) =>
    this.post<{ status: string }>(`/runs/${runId}/close`, { aborted: true, reason }, repo);
  attach = (runId: string, by: string, repo?: string) => this.post(`/runs/${runId}/attach`, { by }, repo);
  release = (runId: string, repo?: string) => this.post(`/runs/${runId}/release`, {}, repo);
  answer = (
    runId: string,
    question: string,
    choices: string[],
    by: string,
    text?: string,
    origin?: "inbox",
    repo?: string,
  ) =>
    this.post<Question>(
      `/runs/${runId}/answer`,
      { question, choices, by, ...(text ? { text } : {}), ...(origin ? { origin } : {}) },
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
