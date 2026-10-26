import {
  type Agent,
  type BasicCapability,
  type GeneratedFile,
  generatedMarker,
  type HostAgentContext,
  type HostGenerator,
  metatorGroups,
  userInvocable,
  withMetatorCommand,
} from "@metator/core";
import { stringify } from "yaml";

/** The one place that knows Copilot's tool names (VS Code custom agents). Changes go here only. */
export const COPILOT_TOOLS: Readonly<Record<BasicCapability, readonly string[]>> = {
  read: ["read"],
  search: ["search"],
  edit: ["edit"],
  execute: ["execute"],
  agent: ["agent"],
  todo: ["todo"],
  web: ["web"],
};

/** `.github/agents/<id>.agent.md` (ADR-0030). */
export class CopilotGenerator implements HostGenerator {
  readonly host = "copilot";
  readonly owns = [".github/agents/*.agent.md"];

  agent(agent: Agent, body: string, context: HostAgentContext): GeneratedFile {
    const groups = metatorGroups(agent);
    const tools = new Set<string>();
    for (const c of agent.capabilities) {
      if (c.startsWith("metator:")) tools.add("execute");
      else for (const t of COPILOT_TOOLS[c as BasicCapability]) tools.add(t);
    }
    const front = {
      name: agent.id,
      description: agent.description,
      tools: [...tools],
      ...(agent.delegates.length > 0 ? { agents: [...agent.delegates] } : {}),
      ...(context.model ? { model: context.model } : {}),
      "user-invocable": userInvocable(agent),
    };
    return {
      path: `.github/agents/${agent.id}.agent.md`,
      content: `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${generatedMarker(context.source)}\n${commandsNote(groups, context.metatorCommand)}${prose(body, context)}`,
    };
  }
}

/** Copilot cannot scope `execute` to commands, so the allowed groups are stated in the prompt. */
function commandsNote(groups: readonly string[], command: string): string {
  if (groups.length === 0) return "";
  return `\n> Run MetatorAI only as: ${groups.map((g) => `\`${command} ${g} …\``).join(", ")}. Every command prints one JSON line.\n`;
}

function prose(body: string, context: HostAgentContext): string {
  const text = withMetatorCommand(body, context.metatorCommand);
  return text.startsWith("\n") ? text : `\n${text}`;
}
