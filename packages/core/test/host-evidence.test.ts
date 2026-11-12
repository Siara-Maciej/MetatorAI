import { describe, expect, test } from "bun:test";
import { hostsFromEvidence, repositoryHosts } from "../src/domain/config.ts";

describe("hostsFromEvidence (`metator setup`)", () => {
  test("the repository's folders decide; the machine's binaries when the repository shows nothing", () => {
    expect(hostsFromEvidence({ repository: ["claude"], machine: [] })).toEqual({
      hosts: ["claude"],
      ask: false,
    });
    expect(hostsFromEvidence({ repository: ["claude"], machine: ["copilot", "claude"] })).toEqual({
      hosts: ["claude"],
      ask: false,
    });
    expect(hostsFromEvidence({ repository: [], machine: ["copilot"] })).toEqual({
      hosts: ["copilot"],
      ask: false,
    });
    expect(hostsFromEvidence({ repository: ["claude", "copilot"], machine: [] }).hosts).toEqual([
      "copilot",
      "claude",
    ]);
  });

  test("no evidence, or evidence that points two ways, is a question with every candidate preselected", () => {
    expect(hostsFromEvidence({ repository: [], machine: [] })).toEqual({
      hosts: ["copilot", "claude"],
      ask: true,
    });
    expect(hostsFromEvidence({ repository: ["copilot"], machine: ["claude"] })).toEqual({
      hosts: ["copilot", "claude"],
      ask: true,
    });
  });

  test("repositoryHosts: a .claude folder or CLAUDE.md; Copilot's instructions, agents, skills or prompts", () => {
    expect(repositoryHosts([".claude/settings.json", "src/a.ts"])).toEqual(["claude"]);
    expect(repositoryHosts(["CLAUDE.md"])).toEqual(["claude"]);
    expect(repositoryHosts([".github/copilot-instructions.md"])).toEqual(["copilot"]);
    expect(repositoryHosts([".github/agents/x.agent.md", ".claude/agents/x.md"])).toEqual([
      "copilot",
      "claude",
    ]);
    // Workflows and a CODEOWNERS file say nothing about an AI host.
    expect(repositoryHosts([".github/workflows/ci.yml", ".github/CODEOWNERS", "docs/claude.md"])).toEqual([]);
  });
});
