/**
 * The daemon's JSON and WebSockets, as the app sees them (D7, ADR-0078). These shapes mirror
 * `metator serve`; the app has no domain logic of its own and imports nothing from MetatorAI.
 */

export type Attention = "you" | "driving" | "stopped" | "done" | "escalated" | "aborted";
export type StageState = "done" | "current" | "waiting" | "pending" | "stopped";

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
  readonly topic: "info" | "contract" | "shared-file" | "done";
  readonly text: string;
  readonly refs: readonly string[];
  readonly by: string;
}

export interface Conflict {
  readonly runs: readonly [string, string];
  readonly files: readonly string[];
  readonly mergeFirst: string;
}

export interface PtySession {
  readonly runId: string;
  readonly host: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly alive: boolean;
  readonly exitCode?: number;
  readonly idle: boolean;
  readonly lastOutputAt?: string;
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
  readonly live?: PtySession & { readonly paneId: string; readonly role: PaneRole };
  readonly state?: { readonly state: PaneState; readonly reason: string };
}

export interface WorkspaceView {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly runId?: string;
  readonly group?: string;
  readonly tabs: readonly {
    readonly id: string;
    readonly label: string;
    readonly panes: readonly string[];
  }[];
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
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string };
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
  conflicts = (repo?: string) => this.get<{ conflicts: Conflict[] }>("/conflicts", repo);
  activity = (runId: string, repo?: string, tail?: number) =>
    this.get<{ entries: Activity[] }>(`/runs/${runId}/activity${tail ? `?tail=${tail}` : ""}`, repo);
  messages = (runId: string, repo?: string) =>
    this.get<{ messages: RunMessage[] }>(`/runs/${runId}/messages`, repo);
  brief = (runId: string, repo?: string, since?: string) =>
    this.get<Brief>(`/runs/${runId}/brief${since ? `?since=${encodeURIComponent(since)}` : ""}`, repo);
  seen = (runId: string, repo?: string) => this.post<{ at: string }>(`/runs/${runId}/seen`, {}, repo);
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
  approve = (runId: string, gate: string, by: string, choice?: string, repo?: string) =>
    this.post(`/runs/${runId}/approve`, { gate, by, ...(choice ? { choice } : {}) }, repo);
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
    },
    repo?: string,
  ) => this.post<{ run: { runId: string }; drive?: { error?: string } }>("/runs", input, repo);
  ptyOpen = (runId: string, host?: string, repo?: string) =>
    this.post<PtySession>(`/runs/${runId}/pty-open`, host ? { host } : {}, repo);
  ptyClose = (runId: string, repo?: string) => this.post(`/runs/${runId}/pty-close`, {}, repo);
  layout = (repo?: string) => this.get<LayoutView>("/layout", repo);
  openPane = (
    input: {
      runId?: string;
      workspace?: string;
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
}
