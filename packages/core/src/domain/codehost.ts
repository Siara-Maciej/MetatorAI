import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { APPROVE_PATTERN } from "./guard-commands.ts";
import type { IntakeConfig, IntakeKind, IntakeSource } from "./intake.ts";
import { err, ok, type Result } from "./result.ts";
import type { ReviewSource } from "./review-thread.ts";

/**
 * One configuration of the code hosts (ADR-0097, MetatorConfig v15): the repositories MetatorAI
 * reads, each with the tool that reads it (an MCP server or GitHub's `gh`), shared by intake and
 * reviews. Tokens are never here: they stay in the MCP server's configuration or in gh's login.
 */
export const CODEHOST_KINDS = ["github", "gitlab", "jira"] as const satisfies readonly IntakeKind[];
export type CodeHostKind = (typeof CODEHOST_KINDS)[number];

/** How a source is read: `gh` (GitHub's CLI with its own login) or `mcp:<server>` (a server in `mcp:`). */
export type CodeHostVia = "gh" | `mcp:${string}`;
const VIA = /^(?:gh|mcp:[A-Za-z0-9._-]+)$/;

export const CodeHostSourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "a source id: lowercase letters, digits, dashes"),
  kind: z.enum(CODEHOST_KINDS),
  /** `owner/name` (GitHub) or the project path (GitLab). */
  repo: z.string().min(1).optional(),
  /** The Jira project key. */
  project: z.string().min(1).optional(),
  via: z.string().regex(VIA, 'how the source is read: "gh" or "mcp:<server>"'),
  /** My requests are this author's (reviews of my MRs); every open request when omitted. */
  author: z.string().min(1).optional(),
});
export type CodeHostSource = z.output<typeof CodeHostSourceSchema>;

/** What is wrong with a source, in a sentence; undefined when nothing is. */
export function sourceProblem(
  s: Pick<CodeHostSource, "id" | "kind" | "repo" | "project" | "via">,
): string | undefined {
  if (s.kind === "jira") {
    if (!s.project) return `source ${s.id}: a jira source names its project`;
    if (s.via === "gh") return `source ${s.id}: jira is read through an MCP server ("mcp:<server>")`;
    return undefined;
  }
  if (!s.repo) return `source ${s.id}: a ${s.kind} source names its repo`;
  if (s.via === "gh" && s.kind !== "github")
    return `source ${s.id}: gh reads GitHub only; GitLab is read through MCP`;
  return undefined;
}

export const CodeHostReviewSchema = z.strictObject({
  /** Publish a review without asking (the approval gate is skipped, autonomy L1). */
  autoPublish: z.boolean().default(false),
  /** Watch reviewed MRs and MRs I am asked to review for new commits and replies. */
  watch: z.boolean().default(true),
  /** How often the daemon looks at the watched MRs. */
  everyMs: z.number().int().min(1000).default(120_000),
});

export const CodeHostMineSchema = z.strictObject({
  /** Analyse a new review on my MR by itself (start `reviews.workflow`); else a card asks first. */
  analyse: z.boolean().default(false),
});

export const CodeHostConfigSchema = z
  .strictObject({
    sources: z.array(CodeHostSourceSchema).default([]),
    review: CodeHostReviewSchema.default(CodeHostReviewSchema.parse({})),
    mine: CodeHostMineSchema.default(CodeHostMineSchema.parse({})),
  })
  .superRefine((c, ctx) => {
    if (new Set(c.sources.map((s) => s.id)).size !== c.sources.length)
      ctx.addIssue({ code: "custom", message: "codehost source ids must be unique" });
    for (const s of c.sources) {
      const problem = sourceProblem(s);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
  });
export type CodeHostConfig = z.output<typeof CodeHostConfigSchema>;

/** The MCP server a `via` names; undefined for gh. */
export const viaServer = (via: string): string | undefined =>
  via.startsWith("mcp:") ? via.slice("mcp:".length) : undefined;

/** The sources reviews read (GitHub and GitLab ones), as the review port takes them. */
export function reviewSourcesOf(codehost: Pick<CodeHostConfig, "sources">): ReviewSource[] {
  const out: ReviewSource[] = [];
  for (const s of codehost.sources) {
    if (s.kind === "jira" || !s.repo) continue;
    const server = viaServer(s.via);
    out.push({
      kind: s.kind,
      repo: s.repo,
      ...(s.author ? { author: s.author } : {}),
      ...(server ? { mcp: server } : {}),
    });
  }
  return out;
}

/** A v15 intake rule: the source by its id, the filters on the rule. */
export interface IntakeRuleSettings {
  readonly id: string;
  readonly source: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly type?: string | undefined;
  readonly tool?: string | undefined;
  readonly workflow: string;
  readonly autonomy: "gated" | "full";
  readonly worktree: boolean;
}

/** Intake as the scan reads it: each rule with its source resolved from `codehost.sources`. */
export function resolveIntake(
  intake: {
    readonly everyMs: number;
    readonly maxActive: number;
    readonly rules: readonly IntakeRuleSettings[];
  },
  sources: readonly CodeHostSource[],
): IntakeConfig {
  const rules = intake.rules.flatMap((r) => {
    const s = sources.find((x) => x.id === r.source);
    if (!s) return [];
    const server = viaServer(s.via);
    const source: IntakeSource = {
      kind: s.kind,
      ...(s.repo ? { repo: s.repo } : {}),
      ...(s.project ? { project: s.project } : {}),
      labels: [...r.labels],
      ...(r.type ? { type: r.type } : {}),
      state: r.state,
      ...(server ? { mcp: server } : {}),
      ...(r.tool ? { tool: r.tool } : {}),
    };
    return [{ id: r.id, source, workflow: r.workflow, autonomy: r.autonomy, worktree: r.worktree }];
  });
  return { everyMs: intake.everyMs, maxActive: intake.maxActive, rules };
}

/** A pull (merge) request named by its link. */
export interface MrRef {
  readonly kind: "github" | "gitlab";
  /** The link's host name (`github.com`). */
  readonly host: string;
  /** `owner/name` (GitHub) or the project path (GitLab). */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
}

/**
 * A link to a GitHub pull request (`https://<host>/<owner>/<repo>/pull/<n>`) or a GitLab merge
 * request (`https://<host>/<group>/…/<project>/-/merge_requests/<n>`); anything else is USAGE.
 */
export function parseMrUrl(text: string): Result<MrRef, MetatorError> {
  const refused = () =>
    err(
      MetatorError.usage(
        `not a link to a pull or merge request: ${text}`,
        "Give the request's address, e.g. https://github.com/acme/shop/pull/45.",
      ),
    );
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return refused();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return refused();
  const path = url.pathname.replace(/\/+$/, "");
  const lab = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(path);
  if (lab)
    return ok({
      kind: "gitlab",
      host: url.hostname,
      repo: lab[1] as string,
      number: Number(lab[2]),
      url: `${url.origin}${path.replace(/(\/merge_requests\/\d+).*$/, "$1")}`,
    });
  const hub = /^\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:\/.*)?$/.exec(path);
  if (hub) {
    const repo = `${hub[1]}/${hub[2]}`;
    return ok({
      kind: "github",
      host: url.hostname,
      repo,
      number: Number(hub[3]),
      url: `${url.origin}/${repo}/pull/${hub[3]}`,
    });
  }
  return refused();
}

/** What the chat says when nothing can read the MR (ADR-0097). */
export const noToolSentence = (host: string): string =>
  `I cannot open this MR: no code-host tool for ${host} is set up (an MCP server or gh)`;

/**
 * Which tool reads an MR (ADR-0097): the configured source of that repository (its `via`); else
 * an MCP server named after the kind; else, for GitHub, `gh` when it is installed and logged in.
 * None: the refusal the chat says to the person.
 */
export function chooseVia(
  ref: Pick<MrRef, "kind" | "host" | "repo">,
  have: {
    readonly sources: readonly CodeHostSource[];
    readonly servers: readonly string[];
    readonly gh: boolean;
  },
): { readonly via: CodeHostVia; readonly source: ReviewSource } | { readonly refusal: string } {
  const configured = have.sources.find(
    (s) => s.kind === ref.kind && s.repo?.toLowerCase() === ref.repo.toLowerCase(),
  );
  const base = { kind: ref.kind, repo: configured?.repo ?? ref.repo };
  if (configured) {
    const server = viaServer(configured.via);
    return { via: configured.via as CodeHostVia, source: server ? { ...base, mcp: server } : base };
  }
  if (have.servers.includes(ref.kind)) return { via: `mcp:${ref.kind}`, source: { ...base, mcp: ref.kind } };
  if (ref.kind === "github" && have.gh) return { via: "gh", source: base };
  return { refusal: noToolSentence(ref.host) };
}

/** `https://github.com/acme/shop.git`, `git@github.com:acme/shop.git`: the host and the repository path. */
export function remoteRepo(remote: string): { readonly host: string; readonly repo: string } | undefined {
  const text = remote.trim();
  const scp = /^[^@/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(text);
  if (scp) return { host: (scp[1] as string).toLowerCase(), repo: (scp[2] as string).replace(/^\/+/, "") };
  try {
    const url = new URL(text);
    const repo = url.pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    return repo ? { host: url.hostname.toLowerCase(), repo } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a git remote is the MR's repository: the same host and path, case aside. */
export function isSameRepo(remote: string, ref: Pick<MrRef, "host" | "repo">): boolean {
  const r = remoteRepo(remote);
  return (
    r !== undefined && r.host === ref.host.toLowerCase() && r.repo.toLowerCase() === ref.repo.toLowerCase()
  );
}

/** Ids for migrated sources: `<kind>-<repo or project>`, `-2`, `-3` when taken. */
function sourceId(kind: string, name: string, taken: ReadonlySet<string>): string {
  const base = `${kind}-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`.replace(/-+$/, "");
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

type Raw = Record<string, unknown>;

/**
 * v14 → v15: `reviews.sources` and each `intake.rules[].source` become `codehost.sources` (one
 * entry per kind, repository or project and server), the rule keeps the source's id and its
 * filters, and an explicit `guard.commands.ask` gets `metator review approve`.
 */
export function codehostFromV14(v14: unknown): unknown {
  const config = { ...(v14 as Raw) };
  const sources: Raw[] = [];
  const taken = new Set<string>();
  const sourceFor = (s: Raw): string => {
    const kind = String(s.kind);
    const via = `mcp:${typeof s.mcp === "string" ? s.mcp : kind}`;
    const found = sources.find(
      (x) => x.kind === kind && x.repo === s.repo && x.project === s.project && x.via === via,
    );
    if (found) {
      if (s.author !== undefined && found.author === undefined) found.author = s.author;
      return String(found.id);
    }
    const id = sourceId(kind, String(s.repo ?? s.project ?? kind), taken);
    taken.add(id);
    sources.push({
      id,
      kind,
      ...(s.repo !== undefined ? { repo: s.repo } : {}),
      ...(s.project !== undefined ? { project: s.project } : {}),
      via,
      ...(s.author !== undefined ? { author: s.author } : {}),
    });
    return id;
  };
  const reviews = config.reviews as Raw | undefined;
  if (reviews && Array.isArray(reviews.sources)) {
    for (const s of reviews.sources as Raw[]) sourceFor(s);
    const { sources: _moved, ...rest } = reviews;
    config.reviews = rest;
  }
  const intake = config.intake as Raw | undefined;
  if (intake && Array.isArray(intake.rules)) {
    config.intake = {
      ...intake,
      rules: (intake.rules as Raw[]).map((rule) => {
        const s = (rule.source ?? {}) as Raw;
        const id = sourceFor(s);
        return {
          ...rule,
          source: id,
          ...(s.labels !== undefined ? { labels: s.labels } : {}),
          ...(s.state !== undefined ? { state: s.state } : {}),
          ...(s.type !== undefined ? { type: s.type } : {}),
          ...(s.tool !== undefined ? { tool: s.tool } : {}),
        };
      }),
    };
  }
  if (sources.length > 0) config.codehost = { ...((config.codehost as Raw | undefined) ?? {}), sources };
  const guard = config.guard as Raw | undefined;
  const commands = guard?.commands as Raw | undefined;
  if (guard && commands && Array.isArray(commands.ask) && !commands.ask.includes(APPROVE_PATTERN))
    config.guard = { ...guard, commands: { ...commands, ask: [...commands.ask, APPROVE_PATTERN] } };
  return config;
}
