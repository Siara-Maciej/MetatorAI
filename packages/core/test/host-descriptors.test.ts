import { describe, expect, test } from "bun:test";
import {
  adoptChatAgent,
  agentDefinitionFiles,
  chatAgentIn,
  driveHostProblem,
  type HostDescriptor,
  hostBins,
  hostCommand,
  hostStatus,
  type InteractiveHost,
  withoutRealHosts,
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

describe("chatAgentIn: the agent the chat a person opens starts with (ADR-0093)", () => {
  test("mt-chat when the repository holds a host file of it; none otherwise, and with hosts that write no files", async () => {
    const hosts = [sessionOnly, viaProgram, played, viaSdk];
    expect(await chatAgentIn(new InMemoryFileSystem({ ".sdk/mt-chat.md": "chat" }), hosts)).toBe("mt-chat");
    // The canonical file alone is not a host file: no host could start the agent yet.
    const canonOnly = new InMemoryFileSystem({
      "metator/agents/mt-chat.md": "x",
      ".cli/agents/mt-a.md": "a",
    });
    expect(await chatAgentIn(canonOnly, hosts)).toBeUndefined();
    expect(
      await chatAgentIn(new InMemoryFileSystem({ ".sdk/mt-chat.md": "chat" }), [played]),
    ).toBeUndefined();
  });
});

describe("adoptChatAgent: a folder's own copy of the conversation agent (ADR-0114)", () => {
  const hosts = [sessionOnly, viaProgram, played, viaSdk];
  test("each host file comes from the first repository that holds it; nothing else is copied", async () => {
    const folder = new InMemoryFileSystem({});
    const shop = new InMemoryFileSystem({
      ".sdk/mt-chat.md": "shop's chat",
      ".sdk/mt-a.md": "another agent",
    });
    const web = new InMemoryFileSystem({
      ".sdk/mt-chat.md": "web's chat",
      ".cli/agents/mt-chat.md": "web's cli",
    });
    expect((await adoptChatAgent(folder, [shop, web], hosts))._unsafeUnwrap()).toEqual([
      ".sdk/mt-chat.md",
      ".cli/agents/mt-chat.md",
    ]);
    expect((await folder.read(".sdk/mt-chat.md"))._unsafeUnwrap()).toBe("shop's chat");
    expect((await folder.read(".cli/agents/mt-chat.md"))._unsafeUnwrap()).toBe("web's cli");
    expect(await folder.exists(".sdk/mt-a.md")).toBe(false);
  });

  test("a copy that is the same is left alone; one that differs follows the repositories", async () => {
    const folder = new InMemoryFileSystem({ ".sdk/mt-chat.md": "old" });
    const shop = new InMemoryFileSystem({ ".sdk/mt-chat.md": "new" });
    expect((await adoptChatAgent(folder, [shop], hosts))._unsafeUnwrap()).toEqual([".sdk/mt-chat.md"]);
    expect((await folder.read(".sdk/mt-chat.md"))._unsafeUnwrap()).toBe("new");
    expect((await adoptChatAgent(folder, [shop], hosts))._unsafeUnwrap()).toEqual([]);
    // No repository has the agent: the folder gets none, and what it has stays.
    expect((await adoptChatAgent(folder, [new InMemoryFileSystem({})], hosts))._unsafeUnwrap()).toEqual([]);
    expect((await folder.read(".sdk/mt-chat.md"))._unsafeUnwrap()).toBe("new");
  });
});

describe("withoutRealHosts (METATOR_NO_REAL_HOSTS)", () => {
  const session: InteractiveHost = {
    id: "cli",
    start: async () => {
      throw new Error("a real session started");
    },
    resume: async () => {
      throw new Error("a real session started");
    },
  };
  const interactive = { ...viaProgram, interactive: () => session };
  const sdkSession = { ...viaSdk, interactive: () => ({ ...session, id: "sdk" }) };

  const refusal = (hosts: readonly HostDescriptor[]) => (id: string) =>
    hosts.find((h) => h.id === id)?.agent?.refused;

  test("a real host is refused as a driver and as a session, with the reason; it still counts as here", async () => {
    const guarded = withoutRealHosts([interactive, sdkSession, played], {});
    const problem = refusal(guarded);
    // Whether a host is here is unchanged (doctor, the wizard): only starting it is refused.
    expect(driveHostProblem(guarded, {}, () => true)("cli")).toBeUndefined();
    expect(problem("cli")).toContain("cli is a real AI host and METATOR_NO_REAL_HOSTS is set");
    expect(problem("sdk")).toContain("sdk is a real AI host");
    expect(problem("played")).toBeUndefined();
    const agent = guarded[0]?.agent?.host(undefined);
    const events: unknown[] = [];
    for await (const e of agent?.run(
      { agent: "a", prompt: "p", cwd: "." } as never,
      async () => ({ choices: [] }) as never,
    ) ?? [])
      events.push(e);
    expect(events).toEqual([{ type: "result", ok: false, text: problem("cli") }]);
    const started = await guarded[0]
      ?.interactive?.({} as never, undefined)
      .start({} as never, { cols: 80, rows: 24 });
    expect(started?._unsafeUnwrapErr().message).toContain("cli is a real AI host");
    // The scenario host is the same object: nothing about it changes.
    expect(guarded[2]).toBe(played);
  });

  test("a stand-in program named for a host runs; an SDK host is real whatever program is named", () => {
    const bins = { cli: "/tmp/fake-cli", sdk: "/tmp/fake-sdk" };
    const guarded = withoutRealHosts([interactive, sdkSession], bins);
    const problem = refusal(guarded);
    expect(problem("cli")).toBeUndefined();
    expect(guarded[0]).toBe(interactive);
    expect(problem("sdk")).toContain("sdk is a real AI host");
    // Its interactive CLI runs the named program: a stand-in.
    expect(guarded[1]?.interactive).toBe(sdkSession.interactive);
    // The default program's own name is no stand-in.
    expect(refusal(withoutRealHosts([interactive], { cli: "cli" }))("cli")).toContain("real AI host");
  });
});
