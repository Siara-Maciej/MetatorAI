import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@metator/core";
import { bootstrap, HOSTS, hostBinsOf } from "../src/bootstrap.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A directory with a file standing in for a host's program. */
async function program(name: string): Promise<{ dir: string; bin: string; missing: string }> {
  const dir = await mkdtemp(join(tmpdir(), "metator-hosts-"));
  dirs.push(dir);
  const bin = join(dir, name);
  await writeFile(bin, "#!/bin/sh\n");
  return { dir, bin, missing: join(dir, "not-here") };
}

describe("driveHostProblem", () => {
  test("a host that drives agents through its program needs it installed, and says which one", async () => {
    const p = await program("copilot");
    const here = bootstrap({ root: "/repo", bins: { copilot: p.bin } }).resolve("driveHostProblem");
    const gone = bootstrap({ root: "/repo", bins: { copilot: p.missing } }).resolve("driveHostProblem");
    expect(here("copilot")).toBeUndefined();
    expect(gone("copilot")).toBe(`\`${p.missing}\` is not installed`);
  });

  test("a host that needs no program of its own (an SDK, a scenario), or one nobody knows, has no problem", async () => {
    const p = await program("claude");
    const problem = bootstrap({
      root: "/repo",
      bins: { claude: p.missing, copilot: p.bin },
      agentScenario: join(p.dir, "scenario.yml"),
    }).resolve("driveHostProblem");
    expect([problem("claude"), problem("scenario"), problem("opencode"), problem("nobody")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("hostStatus", () => {
  test("each interactive host with its program and whether it can be started, in the configured order", async () => {
    const p = await program("claude");
    const status = bootstrap({
      root: "/repo",
      bins: { claude: p.bin, copilot: p.missing, opencode: p.missing },
    }).resolve("hostStatus");
    expect(status()).toEqual([
      { id: "copilot", command: p.missing, installed: false },
      { id: "claude", command: p.bin, installed: true },
      { id: "opencode", command: p.missing, installed: false },
    ]);
  });

  test("without a program given, each host's own default name is looked up on PATH", () => {
    const status = bootstrap({ root: "/repo" }).resolve("hostStatus")();
    expect(status.map((s) => [s.id, s.command])).toEqual([
      ["copilot", "copilot"],
      ["claude", "claude"],
      ["opencode", "opencode"],
    ]);
    for (const s of status) expect(typeof s.installed).toBe("boolean");
  });

  test("the scenario a test plays comes first and is always there; the order follows supervisor.hostOrder", async () => {
    const p = await program("x");
    const config = {
      config: {
        ...DEFAULT_CONFIG,
        supervisor: { ...DEFAULT_CONFIG.supervisor, hostOrder: ["opencode", "claude"] },
      },
      source: undefined,
    };
    const c = bootstrap({
      root: "/repo",
      config,
      agentScenario: join(p.dir, "scenario.yml"),
      bins: { claude: p.bin, copilot: p.bin, opencode: p.bin },
    });
    expect(c.resolve("hostStatus")()).toEqual([
      { id: "scenario", installed: true },
      { id: "opencode", command: p.bin, installed: true },
      { id: "claude", command: p.bin, installed: true },
      { id: "copilot", command: p.bin, installed: true },
    ]);
    expect([...c.resolve("interactiveHosts").keys()]).toEqual(["scenario", "opencode", "claude", "copilot"]);
  });
});

describe("the hosts of a repository", () => {
  test("agent hosts: Claude and Copilot, and the scenario only when a test plays one", () => {
    expect([...bootstrap({ root: "/repo" }).resolve("agentHosts").keys()]).toEqual(["claude", "copilot"]);
    expect([
      ...bootstrap({ root: "/repo", agentScenario: "/x/scenario.yml" }).resolve("agentHosts").keys(),
    ]).toEqual(["claude", "copilot", "scenario"]);
  });

  test("generators: Copilot then Claude, for agents and for skills", () => {
    const c = bootstrap({ root: "/repo" });
    expect(c.resolve("hostGenerators").map((g) => g.host)).toEqual(["copilot", "claude"]);
    expect(c.resolve("skillGenerators").map((g) => [g.host, g.owns])).toEqual([
      ["copilot", ".github/skills/*/SKILL.md"],
      ["claude", ".claude/skills/*/SKILL.md"],
    ]);
  });
});

describe("defaultDriveHost", () => {
  const withTargets = (
    targets: ("copilot" | "claude")[],
    defaultHost?: string,
    hostOrder: string[] = [],
    agentScenario?: string,
  ) =>
    bootstrap({
      root: "/repo",
      config: {
        config: {
          ...DEFAULT_CONFIG,
          hosts: { ...DEFAULT_CONFIG.hosts, targets },
          supervisor: { ...DEFAULT_CONFIG.supervisor, hostOrder },
        },
        source: undefined,
      },
      ...(defaultHost ? { defaultHost } : {}),
      ...(agentScenario ? { agentScenario } : {}),
    }).resolve("defaultDriveHost")();

  test("the first host the repository generates files for, when the team names no order; Claude when it names none", () => {
    expect([withTargets(["copilot", "claude"]), withTargets(["claude", "copilot"]), withTargets([])]).toEqual(
      ["copilot", "claude", "claude"],
    );
  });

  test("the team's order (supervisor.hostOrder) before the targets: the host every run nobody chose one for takes", () => {
    expect(withTargets(["claude"], undefined, ["scenario", "claude"], "/repo/scenario.yml")).toBe("scenario");
    // An entry the runtime does not drive agents with is passed over.
    expect(withTargets(["claude"], undefined, ["opencode"])).toBe("claude");
  });

  test("the host this program was told to prefer wins, when it drives agents", () => {
    expect([withTargets(["copilot"], "claude"), withTargets(["copilot"], "opencode")]).toEqual([
      "claude",
      "copilot",
    ]);
  });
});

describe("HOSTS", () => {
  test("the environment names a host's program by the host's own variable", () => {
    expect(
      hostBinsOf({
        METATOR_COPILOT_BIN: "/opt/copilot",
        METATOR_OPENCODE_BIN: "/opt/opencode",
        METATOR_CLAUDE_BIN: "",
        METATOR_SCENARIO_BIN: "/x",
      }),
    ).toEqual({ copilot: "/opt/copilot", opencode: "/opt/opencode" });
  });

  test("every host has an id of its own and names its program's variable after it", () => {
    expect(HOSTS.map((h) => h.id)).toEqual(["copilot", "claude", "opencode"]);
    for (const h of HOSTS) expect(h.program?.env).toBe(`METATOR_${h.id.toUpperCase()}_BIN`);
  });
});
