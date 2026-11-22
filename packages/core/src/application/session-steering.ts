import { z } from "zod";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { defineDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";
import type { PaneSensor } from "./pane-sensor.ts";
import type { Panes, PaneView } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

/** What precedes the person's words relayed by the task's main chat (ADR-0093). */
export const RELAY_PREFIX = "[metator] From the person, through the main chat: ";
/** Every line MetatorAI types into a session begins with this: never the person's own words. */
export const METATOR_MARK = "[metator]";

/** Words typed into a terminal UI as one message: a line break would send them early. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/** What the task's main chat is told when the person talked to one of its sessions directly. */
export function directTalkLine(repo: string, agent: string, text: string): string {
  return `${METATOR_MARK} The person told ${repo}/${agent} directly: "${oneLine(text).slice(0, 200)}"`;
}

const LetterSchema = z.strictObject({
  id: z.string().min(1),
  paneId: z.string().min(1),
  /** What is typed, as one message. */
  line: z.string().min(1),
  /** The run whose activity records the delivery. */
  runId: z.string().optional(),
  /** Who the line is for, as the activity names them: `shop-api/mt-implementer (pane w3:p4)`. */
  to: z.string().min(1),
  /** `relay`: the person's words through the chat; `chat`: a note for the task's main chat. */
  kind: z.enum(["relay", "chat"]),
  at: z.iso.datetime(),
});
type Letter = z.output<typeof LetterSchema>;

/** Lines waiting to be typed into panes (`.metator/pane-mail.json`): kept across a daemon restart. */
export const PaneMailDocument = defineDocument("PaneMail", {
  latest: z.strictObject({ letters: z.array(LetterSchema) }),
  hint: "Written by the daemon (`metator session tell`, the direct-talk notice); never edited by hand.",
});
const MAIL_FILE = ".metator/pane-mail.json";

export interface PaneMailDependencies {
  readonly fs: Pick<FileSystem, "read" | "write" | "exists">;
  readonly clock: Clock;
  readonly panes: Pick<Panes, "view">;
  readonly sensor: Pick<PaneSensor, "state">;
  /** Whether the pane's agent waits on a question it asked in its terminal. */
  readonly asksInPane: (paneId: string) => boolean;
  /** Types a line into a pane as a new message: the words, then Enter as its own write. */
  readonly nudge: (paneId: string, text: string) => Promise<Result<void, MetatorError>>;
  readonly journal: Pick<RunJournal, "record">;
}

/**
 * Lines for agents' sessions that wait until the agent is idle (ADR-0093): never typed over its
 * work, over a host's prompt or over a question it asked. One line per pane per look, in the
 * order they were posted; a line for a session that ended is dropped, and the run's activity says so.
 */
export class PaneMail {
  /** One reader-writer of the file at a time in this process: a post and a look never cross. */
  private last: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: PaneMailDependencies) {}

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.last.then(work, work);
    this.last = next.catch(() => undefined);
    return next;
  }

  private async letters(): Promise<Result<Letter[], MetatorError>> {
    const doc = await readDocument(this.d.fs, MAIL_FILE, PaneMailDocument, "json");
    return doc.map((d) => [...(d?.letters ?? [])]);
  }

  private save(letters: readonly Letter[]): Promise<Result<void, MetatorError>> {
    return writeDocument(this.d.fs, MAIL_FILE, PaneMailDocument, { letters: [...letters] }, "json");
  }

  post(letter: Omit<Letter, "id" | "at">): Promise<Result<Letter, MetatorError>> {
    return this.exclusive(() => this.add(letter));
  }

  private async add(letter: Omit<Letter, "id" | "at">): Promise<Result<Letter, MetatorError>> {
    const all = await this.letters();
    if (all.isErr()) return err(all.error);
    const max = all.value.reduce((m, l) => Math.max(m, Number(l.id.slice(1)) || 0), 0);
    const posted: Letter = { ...letter, id: `m${max + 1}`, at: this.d.clock.now().toISOString() };
    const saved = await this.save([...all.value, posted]);
    return saved.map(() => posted);
  }

  /** How many lines wait for each pane. */
  async waiting(): Promise<Result<ReadonlyMap<string, number>, MetatorError>> {
    return (await this.letters()).map((all) => {
      const counts = new Map<string, number>();
      for (const l of all) counts.set(l.paneId, (counts.get(l.paneId) ?? 0) + 1);
      return counts;
    });
  }

  /** Types what can be typed now; returns what was delivered. */
  tick(): Promise<Result<readonly Letter[], MetatorError>> {
    return this.exclusive(() => this.deliver());
  }

  private async deliver(): Promise<Result<readonly Letter[], MetatorError>> {
    const all = await this.letters();
    if (all.isErr()) return err(all.error);
    if (all.value.length === 0) return ok([]);
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const delivered: Letter[] = [];
    const gone: Letter[] = [];
    const seen = new Set<string>();
    for (const letter of all.value) {
      // One message per pane per look: the next waits until the agent is idle again.
      if (seen.has(letter.paneId)) continue;
      seen.add(letter.paneId);
      const pane = view.value.panes.find((p) => p.id === letter.paneId);
      if (!pane || pane.ended || !pane.live?.alive) {
        // A paused pane comes back with its session: its lines wait for it.
        if (pane?.paused && !pane.ended) continue;
        gone.push(letter);
        continue;
      }
      if (pane.paused || this.d.asksInPane(letter.paneId)) continue;
      const state = await this.d.sensor.state(letter.paneId);
      if (state.isErr() || state.value.state !== "idle") continue;
      const typed = await this.d.nudge(letter.paneId, letter.line);
      if (typed.isErr()) continue;
      delivered.push(letter);
    }
    if (delivered.length === 0 && gone.length === 0) return ok([]);
    // Every line a pane that ended still had goes with it.
    const dead = new Set(gone.map((g) => g.paneId));
    const dropped = all.value.filter((l) => dead.has(l.paneId));
    const done = new Set([...delivered, ...dropped].map((l) => l.id));
    const saved = await this.save(all.value.filter((l) => !done.has(l.id)));
    if (saved.isErr()) return err(saved.error);
    for (const [letters, said] of [
      [
        delivered,
        (l: Letter) =>
          l.kind === "chat" ? `told the chat (${l.to}): ${l.line}` : `relayed to ${l.to}: ${l.line}`,
      ],
      [dropped, (l: Letter) => `not relayed to ${l.to}, its session ended: ${l.line}`],
    ] as const)
      for (const l of letters) {
        if (!l.runId) continue;
        const noted = await this.d.journal.record(l.runId, { type: "message", origin: "run", text: said(l) });
        if (noted.isErr()) return err(noted.error);
      }
    return ok(delivered);
  }
}

/** One agent session as `metator session list` shows it. */
export interface SessionView {
  readonly pane: string;
  readonly repo: string;
  readonly role: string;
  readonly agent: string;
  readonly label: string;
  readonly runId?: string;
  readonly worker?: string;
  /** working, blocked, waiting, idle, exited (the pane sensor), or ended, paused. */
  readonly state: string;
  /** The task's main chat: the pane the task was given in. */
  readonly main?: true;
  /** Lines that wait to be typed into it. */
  readonly queued?: number;
}

/** The pane a call comes from (its token), as far as steering needs it. */
export type CallerPane = Pick<PaneView, "id" | "startedRun">;

export interface SessionSteeringDependencies {
  readonly panes: Pick<Panes, "view">;
  readonly repo: Pick<RunRepository, "load" | "list">;
  readonly mail: Pick<PaneMail, "post" | "waiting">;
  /** Esc into the pane, then the words, then Enter as its own write. */
  readonly interrupt: (paneId: string, text: string) => Promise<Result<void, MetatorError>>;
  readonly journal: Pick<RunJournal, "record">;
  /** The repository's name, as the person knows it (a folder's name for it, else its directory). */
  readonly repoName: string;
  /**
   * Whether the daemon typed these words into the pane lately (its own line, or a person's answer
   * to a card typed for them): a host reports them like any prompt, and neither is the person
   * talking to the session directly.
   */
  readonly typedByDaemon: (paneId: string, text: string) => Promise<boolean>;
  readonly sensor?: Pick<PaneSensor, "state">;
}

/**
 * Steering a task's sessions from its main chat (ADR-0093): which sessions it has, the person's
 * words relayed to one (when its agent is idle, or at once after Esc), and the chat hearing of it
 * when the person talks to a session directly. Only the task's main chat (the pane the task was
 * started from) or a person steers; what is relayed is the person's words behind a fixed prefix.
 */
export class SessionSteering {
  constructor(private readonly d: SessionSteeringDependencies) {}

  /** The run and the runs above it (a system run's child, its parent): the task a pane works for. */
  private async taskOf(runId: string): Promise<string[]> {
    const chain = [runId];
    for (let id = runId; chain.length < 4; ) {
      const record = await this.d.repo.load(id);
      const parent = record.isOk() ? record.value.parent : undefined;
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      id = parent;
    }
    return chain;
  }

  private async state(pane: PaneView): Promise<string> {
    if (pane.ended) return "ended";
    if (pane.paused) return "paused";
    if (pane.state) return pane.state.state;
    const sensed = await this.d.sensor?.state(pane.id);
    return sensed?.isOk() ? sensed.value.state : pane.live?.alive ? "working" : "exited";
  }

  /** The agent sessions of a task (its main chat, its run's panes, its child runs' panes), or all of them. */
  async list(input: { readonly task?: string }): Promise<Result<readonly SessionView[], MetatorError>> {
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const waiting = await this.d.mail.waiting();
    if (waiting.isErr()) return err(waiting.error);
    let runs: Set<string> | undefined;
    if (input.task) {
      runs = new Set([input.task]);
      for (const id of await this.d.repo.list()) {
        const record = await this.d.repo.load(id);
        if (record.isOk() && record.value.parent === input.task) runs.add(id);
      }
    }
    const out: SessionView[] = [];
    for (const pane of view.value.panes) {
      if (pane.process.kind !== "host") continue;
      const main = pane.startedRun !== undefined && (!input.task || pane.startedRun === input.task);
      if (runs && !(main || (pane.runId !== undefined && runs.has(pane.runId)))) continue;
      const queued = waiting.value.get(pane.id);
      out.push({
        pane: pane.id,
        repo: this.d.repoName,
        role: pane.role,
        agent: pane.process.agent,
        label: pane.label,
        ...(pane.runId ? { runId: pane.runId } : {}),
        ...(pane.worker ? { worker: pane.worker.name } : {}),
        state: await this.state(pane),
        ...(main ? { main: true as const } : {}),
        ...(queued ? { queued } : {}),
      });
    }
    return ok(out);
  }

  /**
   * Why a pane may not steer another: only the main chat of the task the session works for (the
   * pane that task was started from). Undefined when it may, and for a session that is not there
   * (the call itself says what is wrong with it).
   */
  async refusal(paneId: string, from: CallerPane): Promise<MetatorError | undefined> {
    const view = await this.d.panes.view();
    const pane = view.isOk() ? view.value.panes.find((p) => p.id === paneId) : undefined;
    if (!pane?.runId) return undefined;
    const task = await this.taskOf(pane.runId);
    return from.startedRun && task.includes(from.startedRun) && from.id !== pane.id
      ? undefined
      : new MetatorError(
          "TRANSITION_DENIED",
          `pane ${from.id} is not the main chat of the task of pane ${pane.id} (run ${pane.runId}): only that chat or a person steers its sessions`,
        );
  }

  /**
   * Why a session that ended cannot be told, with the live sessions of its task: nothing is sent
   * or queued (a letter for an ended session reaches nobody), and the caller can pick another.
   */
  private async ended(pane: PaneView, runId: string): Promise<MetatorError> {
    const task = (await this.taskOf(runId)).at(-1) as string;
    const sessions = await this.list({ task });
    const live = (sessions.isOk() ? sessions.value : []).filter(
      (s) => s.pane !== pane.id && s.state !== "ended" && s.state !== "exited",
    );
    const who = pane.worker ? `worker ${pane.worker.name}` : pane.role;
    const named = (s: SessionView) =>
      `${s.pane} ${s.repo}/${s.agent} (${s.main ? "the main chat" : s.role}, ${s.state})`;
    return new MetatorError(
      "TRANSITION_DENIED",
      `the session in pane ${pane.id} (${this.d.repoName}/${pane.process.kind === "host" ? pane.process.agent : pane.label}, ${who} of run ${runId}) ended: nothing was sent. ${
        live.length > 0
          ? `The live sessions of its task: ${live.map(named).join(", ")}`
          : "No session of its task is live."
      }`,
      {
        hint: "Tell one of them (`metator session tell <pane> --text …`), or say to the person that this session ended.",
        details: { ended: pane.id, live },
      },
    );
  }

  /** The session to steer and the words for it, or why not. */
  private async target(input: {
    readonly paneId: string;
    readonly text: string;
    readonly from?: CallerPane;
    readonly by?: string;
  }): Promise<Result<{ pane: PaneView; runId: string; line: string; to: string }, MetatorError>> {
    const words = oneLine(input.text);
    if (words === "") return err(MetatorError.usage("say what to tell: --text <the person's words>"));
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const pane = view.value.panes.find((p) => p.id === input.paneId);
    if (!pane) return err(MetatorError.notFound(`pane ${input.paneId}`));
    if (pane.process.kind !== "host" || !pane.runId)
      return err(MetatorError.usage(`pane ${pane.id} is no agent session of a run: nothing to tell`));
    if (pane.ended || !pane.live?.alive) return err(await this.ended(pane, pane.runId));
    if (input.from) {
      const refused = await this.refusal(pane.id, input.from);
      if (refused) return err(refused);
    } else if (!input.by?.trim()) return err(MetatorError.usage("say who you are: --by <name>"));
    const prefix = input.from ? RELAY_PREFIX : `${METATOR_MARK} From the person (${input.by?.trim()}): `;
    return ok({
      pane,
      runId: pane.runId,
      line: `${prefix}${words}`,
      to: `${this.d.repoName}/${pane.process.agent} (pane ${pane.id})`,
    });
  }

  /** The person's words for a session: typed when its agent is idle, queued until then. */
  async tell(input: {
    readonly paneId: string;
    readonly text: string;
    /** The pane the call comes from; none: a person at their own terminal, named by `by`. */
    readonly from?: CallerPane;
    readonly by?: string;
  }): Promise<
    Result<{ readonly pane: string; readonly queued: true; readonly state: string }, MetatorError>
  > {
    const target = await this.target(input);
    if (target.isErr()) return err(target.error);
    const { pane, runId, line, to } = target.value;
    const posted = await this.d.mail.post({ paneId: pane.id, line, runId, to, kind: "relay" });
    if (posted.isErr()) return err(posted.error);
    return ok({ pane: pane.id, queued: true, state: await this.state(pane) });
  }

  /** The person's words for a session, now: Esc stops what its agent does, then the words. */
  async interrupt(input: {
    readonly paneId: string;
    readonly text: string;
    readonly from?: CallerPane;
    readonly by?: string;
  }): Promise<Result<{ readonly pane: string; readonly interrupted: true }, MetatorError>> {
    const target = await this.target(input);
    if (target.isErr()) return err(target.error);
    const { pane, runId, line, to } = target.value;
    const typed = await this.d.interrupt(pane.id, line);
    if (typed.isErr()) return err(typed.error);
    const noted = await this.d.journal.record(runId, {
      type: "message",
      origin: "run",
      text: `interrupted ${to}: ${line}`,
    });
    if (noted.isErr()) return err(noted.error);
    return ok({ pane: pane.id, interrupted: true });
  }

  /**
   * The person sent a message in a run's session themselves (the host's user-prompt hook): what
   * the task's main chat is to be told, and the task's runs. Nothing for what MetatorAI typed,
   * for the session's own first prompt, and for a pane that is no run's session.
   */
  async directTalk(input: {
    readonly paneId: string;
    readonly text: string;
  }): Promise<Result<{ readonly task: readonly string[]; readonly line: string } | undefined, MetatorError>> {
    const words = oneLine(input.text);
    if (words === "" || words.startsWith(METATOR_MARK)) return ok(undefined);
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const pane = view.value.panes.find((p) => p.id === input.paneId);
    if (pane?.process.kind !== "host" || !pane.runId) return ok(undefined);
    if (oneLine(pane.process.prompt) === words) return ok(undefined);
    if (await this.d.typedByDaemon(pane.id, input.text)) return ok(undefined);
    return ok({
      task: await this.taskOf(pane.runId),
      line: directTalkLine(this.d.repoName, pane.process.agent, words),
    });
  }

  /** Posts a line to this repository's main chats of a task; returns the panes it waits for. */
  async tellChats(task: readonly string[], line: string): Promise<Result<readonly string[], MetatorError>> {
    const view = await this.d.panes.view();
    if (view.isErr()) return err(view.error);
    const told: string[] = [];
    for (const pane of view.value.panes) {
      if (!pane.startedRun || !task.includes(pane.startedRun) || pane.ended || !pane.live?.alive) continue;
      const posted = await this.d.mail.post({
        paneId: pane.id,
        line,
        runId: pane.startedRun,
        to: `pane ${pane.id}`,
        kind: "chat",
      });
      if (posted.isErr()) return err(posted.error);
      told.push(pane.id);
    }
    return ok(told);
  }
}
