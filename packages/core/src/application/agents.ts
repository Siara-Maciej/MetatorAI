import {
  type Agent,
  AgentDocument,
  BODY_LINES,
  GENERATED_MARKER,
  REQUIRED_SECTIONS,
} from "../domain/agent.ts";
import type { MetatorConfig } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import { DependencyGraph } from "../domain/graph.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { readFrontMatter } from "../domain/versioned.ts";
import type { FileSystem, HostGenerator, ReadonlyFileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

export interface AgentEntry {
  readonly agent: Agent;
  readonly body: string;
  readonly source: string;
}

/** Canonical agents: every `Agent` Markdown document under `paths.agents`. */
export class AgentCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<{
    readonly agents: readonly AgentEntry[];
    readonly problems: readonly { readonly source: string; readonly error: MetatorError }[];
  }> {
    const agents: AgentEntry[] = [];
    const problems: { source: string; error: MetatorError }[] = [];
    for (const source of [...(await this.fs.glob([`${this.paths.agents}/*.md`]))].sort()) {
      const text = await this.fs.read(source);
      if (text.isErr()) continue;
      const agent = readFrontMatter(text.value, source).andThen((raw) => AgentDocument.parse(raw, source));
      if (agent.isErr()) problems.push({ source, error: agent.error });
      else agents.push({ agent: agent.value, body: text.value.replace(/^---\n[\s\S]*?\n---\n/, ""), source });
    }
    return { agents, problems };
  }
}

export interface AgentProblem {
  readonly source: string;
  readonly agent?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** `meta agents-lint`: schema, ids and prefix, delegation (existing, allowed, acyclic), sections, size. */
export class LintAgents {
  constructor(
    private readonly catalog: AgentCatalog,
    private readonly prefix: string,
  ) {}

  async execute(): Promise<
    Result<{ readonly agents: number; readonly problems: readonly AgentProblem[] }, MetatorError>
  > {
    const scan = await this.catalog.scan();
    const problems: AgentProblem[] = scan.problems.map((p) => {
      const issue = (p.error.details?.issues as { path: string }[] | undefined)?.[0];
      return {
        source: p.source,
        severity: "error",
        message: issue ? `${p.error.message} (at ${issue.path})` : p.error.message,
      };
    });
    const byId = new Map<string, AgentEntry>();
    for (const entry of scan.agents) {
      const { agent, source, body } = entry;
      const error = (message: string) =>
        problems.push({ source, agent: agent.id, severity: "error", message });
      const warning = (message: string) =>
        problems.push({ source, agent: agent.id, severity: "warning", message });

      if (byId.has(agent.id)) error(`duplicate agent id ${agent.id} (also in ${byId.get(agent.id)?.source})`);
      else byId.set(agent.id, entry);
      if (!agent.id.startsWith(this.prefix)) error(`id must start with "${this.prefix}"`);
      if (source.split("/").pop() !== `${agent.id}.md`) error(`file must be named ${agent.id}.md`);
      if (agent.delegates.length > 0 && agent.role !== "coordinator") error("only coordinators delegate");
      if (agent.delegates.length > 0 && !agent.capabilities.includes("agent"))
        error('delegating needs the "agent" capability');
      if (agent.role === "worker" && agent.userInvocable) warning("workers are usually not user-invocable");

      const headings = [...body.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)].map((m) => (m[1] as string).toLowerCase());
      for (const names of REQUIRED_SECTIONS[agent.role]) {
        if (!names.some((n) => headings.includes(n.toLowerCase())))
          error(`missing section "# ${names.join('" or "# ')}"`);
      }
      const lines = body.trimEnd().split("\n").length;
      if (lines > BODY_LINES[agent.role])
        error(`body has ${lines} lines, the ${agent.role} budget is ${BODY_LINES[agent.role]}`);
    }

    for (const { agent, source } of scan.agents) {
      for (const d of agent.delegates) {
        if (!byId.has(d))
          problems.push({
            source,
            agent: agent.id,
            severity: "error",
            message: `delegates to unknown agent ${d}`,
          });
      }
    }
    const graph = new DependencyGraph(
      scan.agents.flatMap(({ agent }) =>
        agent.delegates.map((to) => ({ from: agent.id, to, kind: "internal" as const })),
      ),
    );
    for (const cycle of graph.cycles()) {
      problems.push({
        source: byId.get(cycle[0] as string)?.source ?? "",
        severity: "error",
        message: `delegation cycle: ${cycle.join(" → ")}`,
      });
    }
    return ok({ agents: scan.agents.length, problems });
  }
}

export interface GenerateReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly stale: readonly string[];
  /** Generated files whose canonical source is gone. */
  readonly orphaned: readonly string[];
}

/** `metator generate [--check]`: host files from the canon; never a hand-kept copy. */
export class GenerateHosts {
  constructor(
    private readonly catalog: AgentCatalog,
    private readonly generators: readonly HostGenerator[],
    private readonly fs: FileSystem,
    private readonly config: MetatorConfig,
  ) {}

  async execute(input: { readonly check: boolean }): Promise<Result<GenerateReport, MetatorError>> {
    const scan = await this.catalog.scan();
    if (scan.problems.length > 0) {
      return err(
        new MetatorError("INVALID_CONFIG", `${scan.problems.length} invalid agent(s)`, {
          hint: "Run `metator meta agents-lint` for details.",
          details: { problems: scan.problems.map((p) => ({ source: p.source, ...p.error.toJSON() })) },
        }),
      );
    }
    const hosts = this.generators.filter((g) => this.config.hosts.targets.includes(g.host));
    const expected = new Map<string, string>();
    for (const g of hosts) {
      for (const { agent, body, source } of scan.agents) {
        const model = this.config.hosts.models[agent.tier]?.[g.host];
        const file = g.agent(agent, body, {
          source,
          metatorCommand: this.config.hosts.metatorCommand,
          ...(model ? { model } : {}),
        });
        expected.set(file.path, file.content);
      }
    }

    const written: string[] = [];
    const unchanged: string[] = [];
    const stale: string[] = [];
    for (const [path, content] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
      const current = await this.fs.read(path);
      if (current.isOk() && current.value === content) unchanged.push(path);
      else if (input.check) stale.push(path);
      else {
        const saved = await this.fs.write(path, content);
        if (saved.isErr()) return err(saved.error);
        written.push(path);
      }
    }
    const orphaned = new Set<string>();
    for (const g of hosts) {
      for (const path of await this.fs.glob(g.owns)) {
        if (expected.has(path)) continue;
        const text = await this.fs.read(path);
        if (text.isOk() && text.value.includes(GENERATED_MARKER)) orphaned.add(path);
      }
    }
    return ok({ written, unchanged, stale, orphaned: [...orphaned].sort() });
  }
}
