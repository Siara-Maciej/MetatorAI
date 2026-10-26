import { GENERATED_MARKER, userInvocable } from "../domain/agent.ts";
import { type Audit, type AuditKind, type AuditNode, auditGraph, mentionedNames } from "../domain/audit.ts";
import type { MetatorError } from "../domain/errors.ts";
import { ok, type Result } from "../domain/result.ts";
import { readFrontMatter } from "../domain/versioned.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";
import type { AgentCatalog } from "./agents.ts";
import type { SkillCatalog } from "./skills.ts";

/** Host directories agents, prompts and skills live in (Copilot and Claude Code). */
const HOST_FILES: readonly {
  readonly glob: string;
  readonly kind: AuditKind;
  readonly entry: (front: Front) => boolean;
}[] = [
  {
    glob: ".github/agents/*.agent.md",
    kind: "agent",
    entry: (f) => f["user-invocable"] !== false && f["user-invokable"] !== false,
  },
  { glob: ".github/chatmodes/*.chatmode.md", kind: "agent", entry: () => true },
  { glob: ".claude/agents/*.md", kind: "agent", entry: () => false },
  { glob: ".github/prompts/*.prompt.md", kind: "prompt", entry: () => true },
  { glob: ".github/skills/*/SKILL.md", kind: "skill", entry: () => true },
  { glob: ".claude/skills/*/SKILL.md", kind: "skill", entry: () => true },
  { glob: ".claude/commands/*.md", kind: "prompt", entry: () => true },
];

type Front = Record<string, unknown>;

function idOf(path: string, front: Front): string {
  if (typeof front.name === "string") return front.name;
  const parts = path.split("/");
  const file = parts.at(-1) === "SKILL.md" ? (parts.at(-2) as string) : (parts.at(-1) as string);
  return file.replace(/\.(agent|chatmode|prompt)?\.?md$/, "");
}

/** `meta audit`: the canon plus what hosts already have, and the call graph between them. */
export class AuditAgents {
  constructor(
    private readonly agents: Pick<AgentCatalog, "scan">,
    private readonly skills: Pick<SkillCatalog, "scan">,
    private readonly fs: ReadonlyFileSystem,
  ) {}

  async execute(): Promise<Result<Audit, MetatorError>> {
    const agents = (await this.agents.scan()).agents;
    const skills = (await this.skills.scan()).skills;
    const hostFiles: { path: string; kind: AuditKind; front: Front; body: string; entry: boolean }[] = [];
    for (const h of HOST_FILES) {
      for (const path of [...(await this.fs.glob([h.glob]))].sort()) {
        const text = await this.fs.read(path);
        if (text.isErr()) continue;
        const raw = readFrontMatter(text.value, path);
        const front = (
          raw.isOk() && typeof raw.value === "object" && raw.value !== null ? raw.value : {}
        ) as Front;
        hostFiles.push({ path, kind: h.kind, front, body: text.value, entry: h.entry(front) });
      }
    }
    const known = new Set([
      ...agents.map((a) => a.agent.id),
      ...skills.map((s) => s.skill.name),
      ...hostFiles.map((f) => idOf(f.path, f.front)),
    ]);

    const nodes: AuditNode[] = [
      ...agents.map(({ agent, body, source }) => ({
        id: agent.id,
        kind: "agent" as const,
        source,
        origin: "canonical" as const,
        entry: userInvocable(agent),
        references: [
          ...agent.delegates.map((to) => ({ to, via: "delegates" as const })),
          ...mentionedNames(body, known, agent.id)
            .filter((n) => !agent.delegates.includes(n))
            .map((to) => ({ to, via: "mentions" as const })),
        ],
      })),
      ...skills.map(({ skill, body, source }) => ({
        id: skill.name,
        kind: "skill" as const,
        source,
        origin: "canonical" as const,
        entry: true,
        references: mentionedNames(body, known, skill.name).map((to) => ({ to, via: "mentions" as const })),
      })),
      ...hostFiles.map((f) => {
        const id = idOf(f.path, f.front);
        const delegates = Array.isArray(f.front.agents)
          ? f.front.agents.filter((a): a is string => typeof a === "string")
          : [];
        return {
          id,
          kind: f.kind,
          source: f.path,
          origin: f.body.includes(GENERATED_MARKER) ? ("generated" as const) : ("host" as const),
          entry: f.entry,
          references: [
            ...delegates.map((to) => ({ to, via: "delegates" as const })),
            ...mentionedNames(f.body, known, id)
              .filter((n) => !delegates.includes(n))
              .map((to) => ({ to, via: "mentions" as const })),
          ],
        };
      }),
    ];
    return ok(auditGraph(nodes));
  }
}
