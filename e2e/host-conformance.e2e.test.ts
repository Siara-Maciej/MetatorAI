/**
 * The host conformance suite end to end (ADR-0098; real `metator`, a real daemon in a throwaway
 * repository, real PTYs and hooks; never a real AI host): stand-in `claude` and `copilot` programs
 * (`standInHost`) play the hosts. A conforming stand-in passes every check; the Copilot one fails
 * `session-id` (Copilot names its sessions itself), which `diff` lists as the parity gap; a stand-in
 * that never runs the hooks fails the checks that prove them. Where `METATOR_NO_REAL_HOSTS` is set
 * and no stand-in is named, the suite refuses before it sets anything up. `doctor` says which
 * version last passed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standInHost } from "@metator/testing";
import { metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
let bins: string;
const QUICK = ["--settle", "300", "--timeout", "60"];
type Check = { id: string; result: string; last: string };
type Run = {
  host: string;
  cliVersion: string;
  passed: number;
  failed: number;
  report: string;
  rendered: string;
  checks: Check[];
};

/** The temporary directories the suite made: none may stay (they are its throwaway repositories). */
const leftovers = () => readdirSync(tmpdir()).filter((d) => /^metator-conformance-(claude|copilot)-/.test(d));
let before: string[] = [];

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("README.md", "# the person's checkout\n");
  await repo.commit("init");
  bins = await mkdtemp(join(tmpdir(), "metator-standin-"));
  standInHost(join(bins, "ok"), { host: "claude", version: "2.1.0" });
  standInHost(join(bins, "old"), { host: "claude", version: "2.0.0" });
  standInHost(join(bins, "ok"), { host: "copilot", version: "1.0.200" });
  standInHost(join(bins, "nohooks"), { host: "claude", version: "2.1.1", faults: ["skip-hooks"] });
  before = leftovers();
});
afterAll(async () => {
  // A suite that failed half way may leave its throwaway repository: nothing of it outlives the tests.
  for (const dir of leftovers().filter((d) => !before.includes(d))) {
    stopProcessesUnder(join(tmpdir(), dir));
    await rm(join(tmpdir(), dir), { recursive: true, force: true });
  }
  stopProcessesUnder(repo.root);
  await repo.dispose();
  await rm(bins, { recursive: true, force: true });
});

const conformance = (args: string[], env: Record<string, string> = {}) =>
  metator(["host", "conformance", ...args], repo.root, { METATOR_USER: "ana", ...env });

describe("metator host conformance (stand-in hosts, a real daemon)", () => {
  test("where no real host may start and none is stood in for, it refuses before setting anything up", async () => {
    for (const host of ["claude", "copilot"]) {
      const r = await conformance(["--host", host], { METATOR_CLAUDE_BIN: "", METATOR_COPILOT_BIN: "" });
      expect(r.code).not.toBe(0);
      expect((r.json.error as { message: string }).message).toBe(
        "the conformance suite drives a real host; unset METATOR_NO_REAL_HOSTS to run it",
      );
    }
    expect(leftovers()).toEqual(before);
    // A check it does not have is the usage error, with the list.
    const bad = await conformance(["--host", "claude", "--only", "start,teleport"]);
    expect(bad.code).not.toBe(0);
    expect(JSON.stringify(bad.json.error)).toContain("no such check: teleport");
  }, 60_000);

  test("a conforming Claude Code stand-in passes every check; the report is a HostConformance document", async () => {
    const r = await conformance(["--host", "claude", ...QUICK], {
      METATOR_CLAUDE_BIN: join(bins, "ok/claude"),
    });
    expect(r.code).toBe(0);
    const run = r.json.data as Run;
    expect(run.checks.filter((c) => c.result !== "pass")).toEqual([]);
    expect([run.host, run.cliVersion, run.passed, run.failed]).toEqual(["claude", "2.1.0", 11, 0]);
    expect(run.report).toBe(".metator/conformance/conformance-claude-2.1.0.json");
    const doc = JSON.parse(readFileSync(repo.path(run.report), "utf8")) as {
      kind: string;
      schemaVersion: number;
      checks: { id: string; evidence: string }[];
    };
    expect([doc.kind, doc.schemaVersion]).toEqual(["HostConformance", 1]);
    const ev = (id: string) => doc.checks.find((c) => c.id === id)?.evidence ?? "";
    expect(ev("hook-pre-tool-deny")).toContain("guard (GuardAsked");
    expect(ev("hook-pre-tool-deny")).toContain("never runs here");
    expect(ev("hook-pre-tool-ask")).toMatch(/command: git commit -m "conformance ask \w+"/);
    expect(ev("hook-pre-tool-ask")).toContain("reason: `git commit");
    expect(ev("word-consent")).toContain("the user-prompt hook kept the person's consent (commit)");
    expect(ev("resume")).toMatch(/continued: session [0-9a-f-]{36} resumed in pane/);
    expect(ev("text-question")).toContain("options: a) red | b) blue");
    expect(readFileSync(repo.path(run.rendered), "utf8")).toContain("# Host conformance: claude 2.1.0");
    // The throwaway repository and everything that ran in it are gone.
    expect(leftovers()).toEqual(before);
  }, 240_000);

  test("the Copilot CLI stand-in: the same checks; its session id is Copilot's own placeholder, and diff names that gap", async () => {
    const r = await conformance(["--host", "copilot", ...QUICK], {
      METATOR_COPILOT_BIN: join(bins, "ok/copilot"),
    });
    expect(r.code).toBe(0);
    const run = r.json.data as Run;
    expect(run.checks.filter((c) => c.result !== "pass").map((c) => c.id)).toEqual(["session-id"]);
    expect(run.report).toBe(".metator/conformance/conformance-copilot-1.0.200.json");
    const diff = await metator(
      ["host", "conformance", "diff", ".metator/conformance/conformance-claude-2.1.0.json", run.report],
      repo.root,
    );
    expect(diff.code).toBe(0);
    expect(diff.json.data).toEqual({
      a: { host: "claude", cliVersion: "2.1.0", endedAt: expect.any(String) },
      b: { host: "copilot", cliVersion: "1.0.200", endedAt: expect.any(String) },
      differ: [{ id: "session-id", title: "MetatorAI knows the host's session id", a: "pass", b: "fail" }],
      same: 10,
    });
    expect(leftovers()).toEqual(before);
  }, 240_000);

  test("a host that never runs the hooks fails the checks that prove them; --only skips the rest; --keep keeps the repository", async () => {
    const r = await conformance(
      [
        "--host",
        "claude",
        ...QUICK,
        "--only",
        "hook-pre-tool-deny,word-consent,unprompted-allow",
        "--keep",
        "--out",
        "reports",
      ],
      { METATOR_CLAUDE_BIN: join(bins, "nohooks/claude") },
    );
    expect(r.code).toBe(0);
    const run = r.json.data as Run & { kept: string };
    expect(Object.fromEntries(run.checks.map((c) => [c.id, c.result]))).toMatchObject({
      start: "skipped",
      "hook-pre-tool-deny": "fail",
      "word-consent": "fail",
      "unprompted-allow": "fail",
      tell: "skipped",
    });
    expect(run.report).toBe("reports/conformance-claude-2.1.1.json");
    const deny = JSON.parse(readFileSync(repo.path(run.report), "utf8")).checks.find(
      (c: { id: string }) => c.id === "hook-pre-tool-deny",
    ).evidence as string;
    expect(deny).toContain("its hook did not run");
    // Kept: the repository, its setup and its daemon's log, for a look; nothing runs in it any more.
    expect(existsSync(join(run.kept, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(run.kept, "../daemon.log"))).toBe(true);
    expect(stopProcessesUnder(join(run.kept, ".."))).toBe(0);
    await rm(join(run.kept, ".."), { recursive: true, force: true });
  }, 240_000);

  test("metator doctor: the version that last passed; an older one installed here is a warning only", async () => {
    const line = async (bin: string) => {
      const r = await metator(["doctor"], repo.root, { METATOR_CLAUDE_BIN: bin });
      return (r.json.data as { checks: { id: string; status: string; message: string }[] }).checks.filter(
        (c) => c.id === "conformance",
      );
    };
    const today = new Date().toISOString().slice(0, 10);
    expect(await line(join(bins, "ok/claude"))).toContainEqual({
      id: "conformance",
      status: "ok",
      message: `last passed with claude 2.1.0 on ${today}`,
    });
    expect(await line(join(bins, "old/claude"))).toContainEqual(
      expect.objectContaining({
        status: "warn",
        message: `last passed with claude 2.1.0 on ${today}; claude 2.0.0 installed here is older`,
      }),
    );
  }, 60_000);
});
