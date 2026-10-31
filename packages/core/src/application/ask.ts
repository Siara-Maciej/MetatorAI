import {
  type AnswerCitation,
  type Conversation,
  ConversationDocument,
  citationCandidates,
  conversationId,
  findCitations,
  guidePrompt,
} from "../domain/conversation.ts";
import type { AgentAnswer, AgentEvent, AgentQuestion } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { AgentHost, Clock, FileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

export const GUIDE_AGENT = "mt-guide";

/** Conversations of `metator ask` as versioned documents, newest first. */
export class ConversationRepository {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  file(id: string): string {
    return `${this.paths.conversations}/${id}.json`;
  }

  async exists(id: string): Promise<boolean> {
    return this.fs.exists(this.file(id));
  }

  async load(id: string): Promise<Result<Conversation, MetatorError>> {
    const file = this.file(id);
    if (!(await this.fs.exists(file))) {
      return err(
        MetatorError.notFound(`conversation ${id}`, { hint: "`metator ask list` shows the conversations." }),
      );
    }
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file).andThen((raw) => ConversationDocument.parse(raw, file));
  }

  async save(c: Conversation): Promise<Result<void, MetatorError>> {
    return this.fs.write(this.file(c.id), serializeJsonDocument(ConversationDocument.stamp(c)));
  }

  async list(): Promise<Result<readonly Conversation[], MetatorError>> {
    const files = await this.fs.glob([`${this.paths.conversations}/*.json`]);
    const out: Conversation[] = [];
    for (const f of files) {
      const id = f.slice(f.lastIndexOf("/") + 1, -".json".length);
      const c = await this.load(id);
      if (c.isErr()) return err(c.error);
      out.push(c.value);
    }
    return ok(out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
}

export interface AskInput {
  readonly question: string;
  /** The conversation to continue; a new one when omitted. */
  readonly conversation?: string;
  /** The host to ask; a continued conversation keeps its own unless this names another. */
  readonly host?: string;
  /** The host of a new conversation when `host` is not given. */
  readonly defaultHost: string;
  /** Who asks (`METATOR_USER`, else the login). */
  readonly by: string;
  /** Absolute directory the guide reads (a repository or a folder), and whose host files apply. */
  readonly cwd: string;
  readonly projectRoot: string;
  /** How the place is named to the guide: "this repository", "the folder shop (3 repositories)". */
  readonly where: string;
  /** More directories the guide reads: where a folder's linked repositories really are. */
  readonly dirs?: readonly string[];
  /** Each event as it arrives (the terminal streams the answer). */
  readonly onEvent?: (e: AgentEvent) => void;
  /** A question the host asks the person (a permission); the guide only reads, so the default denies. */
  readonly ask?: (q: AgentQuestion) => Promise<AgentAnswer>;
}

export interface AskResult {
  readonly conversation: Conversation;
  readonly answer: string;
  readonly citations: readonly AnswerCitation[];
}

const DENY: AgentAnswer = {
  choices: ["Deny"],
  // The guide hears why, and what it may use instead, so it does not retry the same command.
  text: "mt-guide only reads: search with Grep and Glob or a read-only grep, rg, find or ls on paths inside this directory, read with Read, and run `metator` commands. Nothing else runs here.",
};

/**
 * `metator ask` (G3, ADR-0058): a plain question about the code, answered by mt-guide through the
 * person's AI host, with every cited file checked; a follow-up continues the conversation.
 */
export class AskQuestion {
  constructor(
    private readonly hosts: ReadonlyMap<string, AgentHost>,
    private readonly conversations: ConversationRepository,
    private readonly clock: Clock,
    /** Whether a cited file exists, relative to the directory the guide read. */
    private readonly cited: (cwd: string, path: string) => Promise<boolean>,
  ) {}

  async execute(input: AskInput): Promise<Result<AskResult, MetatorError>> {
    const question = input.question.trim();
    if (!question) return err(MetatorError.usage("ask what?", 'metator ask "How is the discount computed?"'));
    let previous: Conversation | undefined;
    if (input.conversation) {
      const prior = await this.conversations.load(input.conversation);
      if (prior.isErr()) return err(prior.error);
      previous = prior.value;
    }
    const hostId = input.host ?? previous?.host ?? input.defaultHost;
    const host = this.hosts.get(hostId);
    if (!host) {
      return err(
        MetatorError.usage(`unknown host ${hostId}`, `Hosts: ${[...this.hosts.keys()].join(", ")}.`),
      );
    }
    const now = this.clock.now();
    const id =
      previous?.id ?? (await uniqueId(question, now, (candidate) => this.conversations.exists(candidate)));
    // Continue the host's own session only on the host that made it.
    const resume = previous?.host === hostId ? previous.hostSession : undefined;
    let answer = "";
    let failure: string | undefined;
    let session = resume;
    for await (const e of host.run(
      {
        agent: GUIDE_AGENT,
        prompt: guidePrompt(question, input.where, previous?.turns ?? [], resume !== undefined),
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        ...(input.dirs && input.dirs.length > 0 ? { dirs: input.dirs } : {}),
        runDir: `${input.projectRoot}/${this.conversations.file(id).replace(/\/[^/]+$/, "")}`,
        ...(resume ? { resume } : {}),
      },
      input.ask ?? (async () => DENY),
    )) {
      input.onEvent?.(e);
      if (e.type === "session") session = e.id;
      else if (e.type === "text") answer += answer ? `\n${e.text}` : e.text;
      else if (e.type === "result") {
        if (!e.ok) failure = e.text || "the host stopped without an answer";
        else if (e.text && !answer) answer = e.text;
      }
    }
    const citations: AnswerCitation[] = [];
    const known: string[] = [];
    for (const c of findCitations(answer)) {
      let path = c.path;
      let exists = await this.cited(input.cwd, path);
      // A short path relative to a file cited before it: where it really is.
      for (const candidate of exists ? [] : citationCandidates(path, known))
        if (await this.cited(input.cwd, candidate)) {
          path = candidate;
          exists = true;
          break;
        }
      if (exists && path.includes("/")) known.push(path);
      citations.push({ path, line: c.line, exists });
    }
    const at = this.clock.now().toISOString();
    const conversation: Conversation = {
      id,
      title: previous?.title ?? (question.length > 72 ? `${question.slice(0, 71)}…` : question),
      host: hostId,
      ...(session ? { hostSession: session } : {}),
      createdAt: previous?.createdAt ?? now.toISOString(),
      updatedAt: at,
      turns: [
        ...(previous?.turns ?? []),
        { at, by: input.by, question, answer, ok: failure === undefined, citations },
      ],
    };
    const saved = await this.conversations.save(conversation);
    if (saved.isErr()) return err(saved.error);
    if (failure !== undefined) {
      return err(
        new MetatorError("COMMAND_FAILED", `${hostId}: ${failure}`, {
          hint: `The question is kept in ${id}; ask again with \`metator ask --conversation ${id} …\`.`,
          details: { conversation: id },
        }),
      );
    }
    return ok({ conversation, answer, citations });
  }
}

async function uniqueId(
  question: string,
  at: Date,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  const taken = new Set<string>();
  // conversationId asks synchronously; probe the candidates it would try, in order.
  for (;;) {
    const id = conversationId(question, at, (c) => taken.has(c));
    if (!(await exists(id))) return id;
    taken.add(id);
  }
}
