import { describe, expect, test } from "bun:test";
import {
  agentDefinitionFiles,
  driveHostProblem,
  type HostDescriptor,
  hostBins,
  hostCommand,
  hostStatus,
} from "@metator/core";
import { FakeAgentHost, InMemoryFileSystem } from "@metator/testing";

const viaProgram: HostDescriptor = {
  id: "cli",
  program: { env: "METATOR_CLI_BIN", default: "cli" },
  agent: { runsProgram: true, host: () => new FakeAgentHost({}) },
  files: {
    generator: () => {
      throw new Error("not needed");
    },
    skills: () => {
      throw new Error("not needed");
    },
    agentFile: (id) => `.cli/agents/${id}.md`,
  },
};
const viaSdk: HostDescriptor = {
  id: "sdk",
  program: { env: "METATOR_SDK_BIN", default: "sdk" },
  agent: { runsProgram: false, host: () => new FakeAgentHost({}) },
  files: {
    ...(viaProgram.files as NonNullable<HostDescriptor["files"]>),
    agentFile: (id) => `.sdk/${id}.md`,
  },
};
const played: HostDescriptor = { id: "played", agent: viaSdk.agent as NonNullable<HostDescriptor["agent"]> };
const sessionOnly: HostDescriptor = { id: "tui", program: { env: "METATOR_TUI_BIN", default: "tui" } };
const hosts = [viaProgram, viaSdk, played, sessionOnly];
const only =
  (...installed: string[]) =>
  (command: string) =>
    installed.includes(command);

describe("hostBins", () => {
  test("each host's own variable names its program; an empty or foreign variable names none", () => {
    expect(
      hostBins(hosts, { METATOR_CLI_BIN: "/opt/cli", METATOR_SDK_BIN: "", METATOR_PLAYED_BIN: "/x" }),
    ).toEqual({ cli: "/opt/cli" });
  });
});

describe("hostCommand", () => {
  test("the program given for the host, else its default name; none for a host without a program", () => {
    expect([
      hostCommand(viaProgram, { cli: "/opt/cli" }),
      hostCommand(viaProgram, {}),
      hostCommand(played, { played: "/x" }),
    ]).toEqual(["/opt/cli", "cli", undefined]);
  });
});

describe("driveHostProblem", () => {
  test("a host whose agents run its program needs it installed, and the message names it", () => {
    expect(driveHostProblem(hosts, {}, only())("cli")).toBe("`cli` is not installed");
    expect(driveHostProblem(hosts, { cli: "/opt/cli" }, only("cli"))("cli")).toBe(
      "`/opt/cli` is not installed",
    );
    expect(driveHostProblem(hosts, {}, only("cli"))("cli")).toBeUndefined();
  });

  test("an SDK host, a played one, a session-only one and an unknown one have no problem", () => {
    const problem = driveHostProblem(hosts, {}, only());
    expect(["sdk", "played", "tui", "nobody"].map(problem)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("hostStatus", () => {
  test("each host in the order given, with its program and whether it is there; a host without one always is", () => {
    expect(hostStatus([played, sessionOnly, viaProgram], { cli: "/opt/cli" }, only("tui"))).toEqual([
      { id: "played", installed: true },
      { id: "tui", command: "tui", installed: true },
      { id: "cli", command: "/opt/cli", installed: false },
    ]);
  });
});

describe("agentDefinitionFiles", () => {
  test("the files of the given agents that the repository holds, for every host that writes files", async () => {
    const fs = new InMemoryFileSystem({
      ".cli/agents/mt-a.md": "cli a",
      ".sdk/mt-a.md": "sdk a",
      ".sdk/mt-b.md": "sdk b",
      ".cli/agents/other.md": "not asked for",
    });
    // A host that writes no files (a session-only one) is passed over, wherever it is in the list.
    expect(
      await agentDefinitionFiles(fs, [sessionOnly, viaProgram, played, viaSdk], ["mt-a", "mt-b", "mt-c"]),
    ).toEqual({
      ".cli/agents/mt-a.md": "cli a",
      ".sdk/mt-a.md": "sdk a",
      ".sdk/mt-b.md": "sdk b",
    });
  });
});
