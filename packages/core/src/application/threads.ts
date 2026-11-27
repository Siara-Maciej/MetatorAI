import { CHAT_AGENT } from "../domain/conductor.ts";
import { MetatorError } from "../domain/errors.ts";
import { type Attention, stoppedAt } from "../domain/overview.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  THREAD_SUMMARY_MAX,
  THREAD_TITLE_MAX,
  type Thread,
  ThreadDocument,
  type ThreadPane,
  type ThreadTask,
  type ThreadTree,
  threadId,
  threadOfRun,
  threadTree,
  threadWithFact,
} from "../domain/thread.ts";
import type { Clock, FileLock, FileSystem } from "../ports/index.ts";
import { readDocument, scanDocuments, writeDocument } from "./document-io.ts";
import type { RunOverview } from "./overview.ts";
import { folderChatPrompt, type Panes, type PaneView } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";
import type { PaneMail } from "./session-steering.ts";

export const THREADS_DIR = ".metator/threads";
/** The title of a thread a person opens before saying what it is about ("+ New chat"). */
export const NEW_THREAD_TITLE = "New chat";
/** The agent of a thread's chat when the repository has no conversation agent (before round 13). */
const FALLBACK_CHAT_AGENT = "mt-orchestrator";

/** What a new session of an existing thread is told first (both hosts alike: no host-only context). */
export const continueLine = (title: string): string =>
  `[metator] This chat continues the thread "${title}". Run \`metator thread show\` and carry on from it.`;
/** The line a new thread's chat gets first when the agent carried context over from the old topic. */
export const carryLine = (carry: string, from?: string): string =>
  `[metator] Carried over${from ? ` from thread "${from}"` : ""}: ${carry.replace(/\s*[\r\n]+\s*/g, " ").trim()}`;

/** The thread's current chat terminal, as the sidebar opens it. */
export interface ChatLink {
  readonly paneId: string;
  readonly repo?: string;
  readonly status: "live" | "paused" | "ended" | "missing";
}

/** A thread as it is listed: where its chat is, and in a folder, its repository. */
export type ListedThread = Thread & { readonly repo?: string; readonly chat?: ChatLink };

/** The threads of a repository on disk, one JSON file each; changed under a lock shared by every process. */
export class ThreadStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly lock: FileLock,
  ) {}

  file(id: string): string {
    return `${THREADS_DIR}/${id}.json`;
  }

  async load(id: string): Promise<Result<Thread, MetatorError>> {
    // An id is a file name: nothing that could leave the directory.
    const found = /^[a-z0-9-]+$/.test(id)
      ? await readDocument(this.fs, this.file(id), ThreadDocument, "json")
      : ok(undefined);
    if (found.isErr()) return err(found.error);
    return found.value
      ? ok(found.value)
      : err(MetatorError.notFound(`thread ${id}`, { hint: "List them: `metator thread list`." }));
  }

  /** Every thread that can be read, oldest first; one that cannot is left out, not fatal. */
  async list(): Promise<Result<readonly Thread[], MetatorError>> {
    const scan = await scanDocuments(this.fs, [`${THREADS_DIR}/*.json`], ThreadDocument, {
      format: "json",
      unreadable: "skip",
    });
    return ok(scan.entries.map((e) => e.value).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  /** A new thread with a free id: the id is chosen and the file written under one lock. */
  async create<T>(
    make: (
      taken: (id: string) => boolean,
    ) => Promise<Result<{ readonly thread: Thread; readonly value: T }, MetatorError>>,
  ): Promise<Result<{ readonly thread: Thread; readonly value: T }, MetatorError>> {
    return this.lock.hold(THREADS_DIR, async () => {
      const existing = new Set(
        (await this.fs.glob([`${THREADS_DIR}/*.json`])).map((f) => f.slice(f.lastIndexOf("/") + 1, -5)),
      );
      const made = await make((id) => existing.has(id));
      if (made.isErr()) return err(made.error);
      const saved = await writeDocument(
        this.fs,
        this.file(made.value.thread.id),
        ThreadDocument,
        made.value.thread,
        "json",
      );
      return saved.map(() => made.value);
    });
  }

  /** Reads, changes, writes as one step; `change` returning the same object writes nothing. */
  async update(
    id: string,
    change: (thread: Thread) => Result<Thread, MetatorError>,
  ): Promise<Result<Thread, MetatorError>> {
    return this.lock.hold(THREADS_DIR, async () => {
      const current = await this.load(id);
      if (current.isErr()) return err(current.error);
      const next = change(current.value);
      if (next.isErr()) return err(next.error);
      if (next.value === current.value) return ok(current.value);
      const saved = await writeDocument(this.fs, this.file(id), ThreadDocument, next.value, "json");
      return saved.map(() => next.value);
    });
  }
}

export interface ThreadsDependencies {
  readonly store: ThreadStore;
  readonly panes: Pick<Panes, "openWorkspace" | "openTab" | "openPane" | "pane" | "end" | "resumePane">;
  readonly runs: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "activity" | "record">;
  readonly mail: Pick<PaneMail, "post">;
  /** The repository's conversation agent (`mt-chat`) when it has one. */
  readonly chatAgent: () => Promise<string | undefined>;
  readonly clock: Clock;
}

export interface NewThreadInput {
  readonly title?: string;
  readonly by: string;
  readonly host?: string;
  /** One line of context the agent carries over from the old topic: the new chat's first message. */
  readonly carry?: string;
  readonly from?: { readonly issue?: string; readonly thread?: string };
  /** The pane that asked (the agent's `metator thread new`): its thread is where the new one comes from. */
  readonly caller?: Pick<PaneView, "id" | "threadId">;
  /** In a folder: the repository the chat pane is in. */
  readonly repo?: string;
  /** false: no daemon serves the repository, so the thread is made without its chat terminal. */
  readonly pane?: boolean;
  /** The chat of a folder of repositories (ADR-0114): its repositories, named to the agent first. */
  readonly folder?: FolderChat;
  /**
   * Ids taken in the other places of a folder (its repositories, the folder itself): one app lists
   * all their threads, so a new thread's id is taken by none of them.
   */
  readonly takenElsewhere?: readonly string[];
}

/**
 * Where a run of another repository is read and marked: a thread of a folder (ADR-0114) lists
 * runs of the folder's repositories, each of which keeps its own runs.
 */
export interface ThreadRunsElsewhere {
  readonly runs: Pick<RunRepository, "load">;
  readonly journal: Pick<RunJournal, "activity" | "record">;
}

/** What makes a chat the folder's own: the repositories the folder gathers, by name. */
export interface FolderChat {
  readonly repos: readonly string[];
}

/** The threads on the state (`GET /state`, `/ws/state`): when `updatedAt` changes, the tree is read again. */
export interface ThreadsMark {
  readonly open: number;
  readonly closed: number;
  readonly updatedAt?: string;
}

/** How a reopened thread's chat came back. */
export type ReopenHow = "live" | "resumed" | "new-session";

/**
 * Threads (ADR-0095): one per topic, with its chat terminal. The daemon makes a thread with its
 * chat pane, links the runs its chat starts and appends what became of them; the agent writes the
 * summary; a person closes and reopens one. Closing ends the chat terminal, never a run.
 */
export class Threads {
  /** Events already noted in a thread (`<thread> <run> <key>`): the run's activity is read once per daemon. */
  private readonly noted = new Set<string>();

  constructor(private readonly d: ThreadsDependencies) {}

  /** What the state says of the threads: how many, and when one last changed (a client reads the tree again then). */
  async mark(): Promise<ThreadsMark> {
    const all = await this.d.store.list();
    const threads = all.isOk() ? all.value : [];
    const latest = threads.reduce<string | undefined>(
      (m, t) => (m === undefined || t.updatedAt > m ? t.updatedAt : m),
      undefined,
    );
    return {
      open: threads.filter((t) => t.state === "open").length,
      closed: threads.filter((t) => t.state === "closed").length,
      ...(latest ? { updatedAt: latest } : {}),
    };
  }

  /** The id of every thread here, open or closed. */
  async ids(): Promise<readonly string[]> {
    const all = await this.d.store.list();
    return all.isOk() ? all.value.map((t) => t.id) : [];
  }

  show(id: string): Promise<Result<Thread, MetatorError>> {
    return this.d.store.load(id);
  }

  /** Every thread with its chat terminal's state. */
  async listed(repo?: string): Promise<Result<readonly ListedThread[], MetatorError>> {
    const all = await this.d.store.list();
    if (all.isErr()) return err(all.error);
    const out: ListedThread[] = [];
    for (const t of all.value) {
      const chat = await this.chatOf(t);
      out.push({ ...t, ...(repo ? { repo } : {}), ...(chat ? { chat } : {}) });
    }
    return ok(out);
  }

  /** The thread that lists a run (an item from that run's plan belongs to it), if any. */
  async ofRun(runId: string): Promise<Thread | undefined> {
    const all = await this.d.store.list();
    return all.isOk() ? threadOfRun(all.value, runId) : undefined;
  }

  /** The thread a pane is the chat of (the agent's own: `$METATOR_PANE_ID`). */
  async ofPane(paneId: string): Promise<Result<Thread, MetatorError>> {
    const pane = await this.d.panes.pane(paneId);
    if (pane.isErr()) return err(pane.error);
    if (!pane.value.threadId)
      return err(
        MetatorError.usage(
          `pane ${paneId} is the chat of no thread`,
          "Name the thread: --thread <id> (`metator thread list`).",
        ),
      );
    return this.d.store.load(pane.value.threadId);
  }

  async chatOf(thread: Thread): Promise<ChatLink | undefined> {
    const last = thread.panes.at(-1);
    if (!last) return undefined;
    const base = { paneId: last.paneId, ...(last.repo ? { repo: last.repo } : {}) };
    const pane = await this.d.panes.pane(last.paneId);
    if (pane.isErr()) return { ...base, status: "missing" };
    const p = pane.value;
    const status = p.ended ? "ended" : p.live?.alive ? "live" : "paused";
    return { ...base, status };
  }

  /** A new thread and its chat terminal (the conversation agent), or nothing when the terminal cannot start. */
  async create(
    input: NewThreadInput,
  ): Promise<Result<{ readonly thread: Thread; readonly pane?: PaneView }, MetatorError>> {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who opens it: by", "A thread records who opened it."));
    const title = (input.title ?? "").replace(/\s+/g, " ").trim() || NEW_THREAD_TITLE;
    const titled = checkTitle(title);
    if (titled) return err(titled);
    const fromThread = input.from?.thread ?? input.caller?.threadId;
    let fromTitle: string | undefined;
    if (fromThread) {
      const old = await this.d.store.load(fromThread);
      if (old.isErr()) return err(old.error);
      fromTitle = old.value.title;
    }
    const from = {
      ...(input.from?.issue ? { issue: input.from.issue } : {}),
      ...(fromThread ? { thread: fromThread } : {}),
    };
    const made = await this.d.store.create<PaneView | undefined>(async (taken) => {
      const now = this.d.clock.now();
      const at = now.toISOString();
      const elsewhere = new Set(input.takenElsewhere ?? []);
      const id = threadId(title, now, (x) => taken(x) || elsewhere.has(x));
      let pane: PaneView | undefined;
      if (input.pane !== false) {
        const opened = await this.openChat(id, input.host, undefined, input.folder);
        if (opened.isErr()) return err(opened.error);
        pane = opened.value;
      }
      const thread: Thread = {
        id,
        title,
        state: "open",
        createdAt: at,
        updatedAt: at,
        summary: "",
        runs: [],
        issues: [],
        mrs: [],
        panes: pane ? [{ ...(input.repo ? { repo: input.repo } : {}), paneId: pane.id, at }] : [],
        ...(Object.keys(from).length > 0 ? { from } : {}),
        facts: [],
      };
      return ok({
        thread: threadWithFact(
          thread,
          `opened by ${input.by.trim()}${fromThread ? ` from thread ${fromThread}` : ""}`,
          at,
        ),
        value: pane,
      });
    });
    if (made.isErr()) return err(made.error);
    const pane = made.value.value;
    if (pane && input.carry && input.carry.trim() !== "") {
      const posted = await this.d.mail.post({
        paneId: pane.id,
        line: carryLine(input.carry, fromTitle),
        to: `chat (pane ${pane.id})`,
        kind: "chat",
      });
      if (posted.isErr()) return err(posted.error);
    }
    return ok({ thread: made.value.thread, ...(pane ? { pane } : {}) });
  }

  /** The agent's summary of the topic (and, once it knows the topic, a better title). */
  async summary(input: {
    readonly id: string;
    readonly text: string;
    readonly title?: string;
  }): Promise<Result<Thread, MetatorError>> {
    const text = input.text.trim();
    if (text.length > THREAD_SUMMARY_MAX)
      return err(
        MetatorError.usage(
          `the summary is ${text.length} characters: at most ${THREAD_SUMMARY_MAX}`,
          "Keep what a new session needs: the decisions, what is open, the next step.",
        ),
      );
    const title = input.title?.replace(/\s+/g, " ").trim();
    if (title !== undefined) {
      const wrong = checkTitle(title);
      if (wrong) return err(wrong);
    }
    const at = this.d.clock.now().toISOString();
    return this.d.store.update(input.id, (t) =>
      ok({ ...t, summary: text, ...(title ? { title } : {}), updatedAt: at }),
    );
  }

  /** Closed: its chat terminal ends (its session kept to continue), its runs go on. */
  async close(input: {
    readonly id: string;
    readonly by: string;
  }): Promise<Result<{ readonly thread: Thread; readonly ended?: string }, MetatorError>> {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who closes it: by", "Closing records who did."));
    const current = await this.d.store.load(input.id);
    if (current.isErr()) return err(current.error);
    if (current.value.state === "closed") return ok({ thread: current.value });
    const last = current.value.panes.at(-1);
    const pane = last ? await this.d.panes.pane(last.paneId) : undefined;
    let ended: string | undefined;
    let hostSession: string | undefined;
    if (pane?.isOk() && !pane.value.ended) {
      if (pane.value.process.kind === "host") hostSession = pane.value.process.sessionId;
      const r = await this.d.panes.end(pane.value.id, {
        reason: "closed-by-host",
        summary: `thread ${input.id} closed by ${input.by.trim()}`,
      });
      if (r.isErr()) return err(r.error);
      if (r.value.ended) ended = pane.value.id;
    } else if (pane?.isOk() && pane.value.process.kind === "host") hostSession = pane.value.process.sessionId;
    const at = this.d.clock.now().toISOString();
    const closed = await this.d.store.update(input.id, (t) =>
      ok(
        threadWithFact(
          {
            ...t,
            state: "closed",
            closedAt: at,
            panes: t.panes.map((p, i) =>
              i === t.panes.length - 1 && hostSession && !p.hostSession ? { ...p, hostSession } : p,
            ),
          },
          `closed by ${input.by.trim()}`,
          at,
        ),
      ),
    );
    return closed.map((thread) => ({ thread, ...(ended ? { ended } : {}) }));
  }

  /**
   * Open again, with its chat live: a chat that runs is left as it is; a paused one is resumed in
   * its pane; otherwise a new pane continues the kept host session, or starts a new one that is
   * told first which thread it continues (the same line on every host).
   */
  async reopen(input: {
    readonly id: string;
    readonly by: string;
    readonly host?: string;
    readonly repo?: string;
    readonly folder?: FolderChat;
  }): Promise<
    Result<{ readonly thread: Thread; readonly pane: PaneView; readonly how: ReopenHow }, MetatorError>
  > {
    if (input.by.trim() === "")
      return err(MetatorError.usage("say who reopens it: by", "Reopening records who did."));
    const current = await this.d.store.load(input.id);
    if (current.isErr()) return err(current.error);
    const thread = current.value;
    const last = thread.panes.at(-1);
    const found = last ? await this.d.panes.pane(last.paneId) : undefined;
    const old = found?.isOk() ? found.value : undefined;
    let pane: PaneView | undefined;
    let how: ReopenHow = "resumed";
    if (old && !old.ended && old.live?.alive) {
      pane = old;
      how = "live";
    } else if (old && !old.ended && old.process.kind === "host") {
      const back = await this.d.panes.resumePane(old.id);
      if (back.isOk()) pane = back.value;
    }
    let fresh = false;
    if (!pane) {
      const session = last?.hostSession ?? (old?.process.kind === "host" ? old.process.sessionId : undefined);
      const host = input.host ?? (old?.process.kind === "host" ? old.process.host : undefined);
      const resumed = session ? await this.openChat(thread.id, host, session, input.folder) : undefined;
      if (resumed?.isOk()) pane = resumed.value;
      else {
        const opened = await this.openChat(thread.id, host, undefined, input.folder);
        if (opened.isErr()) return err(opened.error);
        pane = opened.value;
        how = "new-session";
        fresh = true;
      }
    }
    const chat = pane;
    if (fresh) {
      const posted = await this.d.mail.post({
        paneId: chat.id,
        line: continueLine(thread.title),
        to: `chat (pane ${chat.id})`,
        kind: "chat",
      });
      if (posted.isErr()) return err(posted.error);
    }
    const at = this.d.clock.now().toISOString();
    const saved = await this.d.store.update(thread.id, (t) => {
      let next: Thread = t;
      if (t.state === "closed") {
        const { closedAt: _was, ...open } = t;
        next = threadWithFact({ ...open, state: "open" }, `reopened by ${input.by.trim()}`, at);
      }
      if (t.panes.at(-1)?.paneId !== chat.id) {
        const entry: ThreadPane = { ...(input.repo ? { repo: input.repo } : {}), paneId: chat.id, at };
        next = threadWithFact(
          { ...next, panes: [...next.panes, entry] },
          `chat continued in pane ${chat.id} (${how === "new-session" ? "new session" : "session resumed"})`,
          at,
        );
      }
      return ok(next);
    });
    return saved.map((t) => ({ thread: t, pane: chat, how }));
  }

  /**
   * The chat of a thread started a run (`metator run new`, `quick start` in its pane): the run is
   * the thread's, with a fact. A child run is its parent's, never a thread's own task.
   */
  async linkRun(
    paneId: string,
    runId: string,
    /** The run's record when it is in another repository of the folder. */
    found?: { readonly task: string; readonly parent?: string | undefined },
  ): Promise<Result<Thread | undefined, MetatorError>> {
    const pane = await this.d.panes.pane(paneId);
    if (pane.isErr() || !pane.value.threadId) return ok(undefined);
    let run = found;
    if (!run) {
      const record = await this.d.runs.load(runId);
      if (record.isErr()) return err(record.error);
      run = record.value;
    }
    if (run.parent) return ok(undefined);
    const task = firstLine(run.task);
    const at = this.d.clock.now().toISOString();
    const linked = await this.d.store.update(pane.value.threadId, (t) =>
      t.runs.includes(runId)
        ? ok(t)
        : ok(threadWithFact({ ...t, runs: [...t.runs, runId] }, `run ${runId} started: ${task}`, at)),
    );
    return linked.map((t) => t);
  }

  /**
   * A run started for the thread from outside its chat (an item's "Implement", ADR-0096): the run
   * is the thread's, with a fact, as `linkRun` makes it for one its chat starts.
   */
  async addRun(id: string, runId: string, task: string): Promise<Result<Thread, MetatorError>> {
    const at = this.d.clock.now().toISOString();
    return this.d.store.update(id, (t) =>
      t.runs.includes(runId)
        ? ok(t)
        : ok(
            threadWithFact(
              { ...t, runs: [...t.runs, runId] },
              `run ${runId} started: ${firstLine(task)}`,
              at,
            ),
          ),
    );
  }

  /** A Backlog item made in the thread (its analysis, an item from its plan): listed in `issues`, with a fact. */
  async addIssue(id: string, issue: string, title: string): Promise<Result<Thread, MetatorError>> {
    const at = this.d.clock.now().toISOString();
    return this.d.store.update(id, (t) =>
      t.issues.includes(issue)
        ? ok(t)
        : ok(
            threadWithFact(
              { ...t, issues: [...t.issues, issue] },
              `Backlog item ${issue} made: ${firstLine(title)}`,
              at,
            ),
          ),
    );
  }

  /** An MR reviewed or analysed from the thread (ADR-0097): listed in `mrs`, with a fact, once. */
  async addMr(id: string, mr: string, title: string): Promise<Result<Thread, MetatorError>> {
    const at = this.d.clock.now().toISOString();
    return this.d.store.update(id, (t) =>
      t.mrs.includes(mr)
        ? ok(t)
        : ok(threadWithFact({ ...t, mrs: [...t.mrs, mr] }, `MR ${mr} followed: ${firstLine(title)}`, at)),
    );
  }

  /**
   * What became of the threads' runs: a run that is done, aborted or stopped for the person gets
   * one fact in each thread that lists it, once per event (the run's activity says it was noted).
   */
  async noteRuns(
    elsewhere: readonly ThreadRunsElsewhere[] = [],
  ): Promise<
    Result<
      readonly { readonly thread: string; readonly runId: string; readonly event: string }[],
      MetatorError
    >
  > {
    const all = await this.d.store.list();
    if (all.isErr()) return err(all.error);
    const out: { thread: string; runId: string; event: string }[] = [];
    for (const thread of all.value) {
      for (const runId of thread.runs) {
        // A run this place does not hold (a folder's chat started it in a repository) is read there.
        let held: ThreadRunsElsewhere = this.d;
        let record = await held.runs.load(runId);
        for (const other of record.isErr() ? elsewhere : []) {
          const found = await other.runs.load(runId);
          if (found.isErr()) continue;
          held = other;
          record = found;
          break;
        }
        // A run that cannot be read now is looked at again later.
        if (record.isErr()) continue;
        const r = record.value;
        const status = r.state.status;
        if (status !== "done" && status !== "aborted" && status !== "escalated" && status !== "planned")
          continue;
        const key = status === "escalated" ? `escalated ${r.updatedAt}` : status;
        const seen = `${thread.id} ${runId} ${key}`;
        if (this.noted.has(seen)) continue;
        const mark = `noted in thread ${thread.id} (${key})`;
        const activity = await held.journal.activity(runId);
        if (activity.isErr()) continue;
        if (activity.value.some((a) => a.text === mark)) {
          this.noted.add(seen);
          continue;
        }
        const task = firstLine(r.task);
        const fact =
          status === "escalated"
            ? `run ${runId} stopped at ${stoppedAt(r.state.stage, status, r.state.context.history)} and needs the person: ${task}`
            : status === "planned"
              ? `run ${runId} planned (plan ready): ${task}`
              : `run ${runId} ${status}: ${task}`;
        const at = this.d.clock.now().toISOString();
        const saved = await this.d.store.update(thread.id, (t) => ok(threadWithFact(t, fact, at)));
        if (saved.isErr()) return err(saved.error);
        const marked = await held.journal.record(runId, { type: "agent", origin: "run", text: mark });
        if (marked.isErr()) return err(marked.error);
        this.noted.add(seen);
        out.push({ thread: thread.id, runId, event: status });
      }
    }
    return ok(out);
  }

  /** A chat terminal for a thread: the conversation agent in a new tab of the "chat" workspace. */
  private async openChat(
    thread: string,
    host?: string,
    sessionId?: string,
    folder?: FolderChat,
  ): Promise<Result<PaneView, MetatorError>> {
    const workspace = await this.d.panes.openWorkspace({ label: "chat" });
    if (workspace.isErr()) return err(workspace.error);
    const tab = await this.d.panes.openTab(workspace.value.id, "chat");
    if (tab.isErr()) return err(tab.error);
    const agent = (await this.d.chatAgent()) ?? FALLBACK_CHAT_AGENT;
    return this.d.panes.openPane({
      workspace: workspace.value.id,
      tab: tab.value,
      role: "apps",
      label: "chat",
      threadId: thread,
      process: {
        kind: "host",
        ...(host ? { host } : {}),
        agent,
        // A chat of a folder is told its repositories; any other gets the agent's own first words.
        prompt: folder && agent === CHAT_AGENT ? folderChatPrompt(folder.repos) : "",
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }
}

function checkTitle(title: string): MetatorError | undefined {
  if (title === "") return MetatorError.usage("a thread needs a title: --title <words>");
  if (title.length > THREAD_TITLE_MAX)
    return MetatorError.usage(
      `the title is ${title.length} characters: at most ${THREAD_TITLE_MAX}`,
      "Name the topic in a few words.",
    );
  return undefined;
}

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim();

/** A run of the overview as a thread's task. */
export const threadTaskOf = (r: RunOverview, repo?: string): ThreadTask => ({
  runId: r.runId,
  ...(repo ? { repo } : {}),
  task: firstLine(r.task),
  status: r.status,
  stage: r.stage,
  attention: r.attention as Attention,
  updatedAt: r.updatedAt,
  ...(r.parent ? { parent: r.parent } : {}),
  ...(r.children && r.children.length > 0 ? { children: r.children } : {}),
});

/**
 * The sidebar's tree over one repository or every repository of a folder: their threads (with
 * their chats) and their runs together. A repository whose threads cannot be read fails the tree.
 */
export async function threadTreeOf(
  repos: readonly {
    readonly repo?: string;
    readonly threads: Pick<Threads, "listed">;
    readonly runs: readonly RunOverview[];
  }[],
): Promise<Result<ThreadTree<ListedThread>, MetatorError>> {
  const threads: ListedThread[] = [];
  const tasks: ThreadTask[] = [];
  for (const r of repos) {
    const listed = await r.threads.listed(r.repo);
    if (listed.isErr()) return err(listed.error);
    threads.push(...listed.value);
    tasks.push(...r.runs.map((x) => threadTaskOf(x, r.repo)));
  }
  return ok(threadTree(threads, tasks));
}
