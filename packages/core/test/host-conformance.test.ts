import { describe, expect, test } from "bun:test";
import {
  boundEvidence,
  CONFORMANCE_CHECK_IDS,
  CONFORMANCE_CHECKS,
  cliVersionOf,
  compareVersions,
  conformanceFileName,
  conformanceLine,
  conformancePassed,
  conformanceSeen,
  diffConformance,
  EVIDENCE_MAX,
  fillConformance,
  type HostConformance,
  HostConformanceDocument,
  MACHINE_LACKS,
  mergeConformance,
  renderConformance,
} from "../src/domain/host-conformance.ts";

const doc = (
  host: string,
  results: Record<string, "pass" | "fail" | "skipped">,
  over: Partial<HostConformance> = {},
): HostConformance => ({
  host,
  cliVersion: "2.1.0",
  os: "linux x64",
  metatorVersion: "0.0.0",
  startedAt: "2026-11-22T10:00:00.000Z",
  endedAt: "2026-11-22T10:20:00.000Z",
  checks: Object.entries(results).map(([id, result]) => ({
    id,
    title: CONFORMANCE_CHECKS.find((c) => c.id === id)?.title ?? id,
    result,
    evidence: `${id}: ${result}`,
    tookMs: 1500,
  })),
  ...over,
});
const all = (result: "pass" | "fail" | "skipped") =>
  Object.fromEntries(CONFORMANCE_CHECK_IDS.map((id) => [id, result])) as Record<string, typeof result>;

describe("the conformance checks are data, the same for every host", () => {
  test("the twelve checks of the contract, in order, each with what it proves and a session", () => {
    expect(CONFORMANCE_CHECK_IDS).toEqual([
      "start",
      "session-id",
      "resume",
      "hook-pre-tool-deny",
      "hook-pre-tool-ask",
      "word-consent",
      "unprompted-allow",
      "text-question",
      "mcp-or-tools",
      "tell",
      "interrupt",
      "sandbox-deny-read",
    ]);
    // Only the sandbox check needs something of the machine; it runs last, after every check
    // that works outside the sandbox.
    expect(CONFORMANCE_CHECKS.filter((c) => c.needs).map((c) => [c.id, c.needs])).toEqual([
      ["sandbox-deny-read", "sandbox"],
    ]);
    for (const c of CONFORMANCE_CHECKS) {
      expect(c.proves.length).toBeGreaterThan(20);
      expect(c.steps.length).toBeGreaterThan(0);
      // Every check proves itself through something MetatorAI observes.
      expect(c.steps.some((s) => "expect" in s)).toBe(true);
    }
    // The run's session opens in `tell`, the first check that works in it.
    expect(CONFORMANCE_CHECKS.filter((c) => c.session === "run").map((c) => c.id)).toEqual([
      "tell",
      "interrupt",
    ]);
  });

  test("no words a check gives the session carry the uppercase it expects back", () => {
    for (const c of CONFORMANCE_CHECKS) {
      const given = c.steps.flatMap((s) =>
        "say" in s ? [s.say] : "tell" in s ? [s.tell] : "interrupt" in s ? [s.interrupt] : [],
      );
      const wanted = c.steps.flatMap((s) => ("expect" in s && "screen" in s.expect ? [s.expect.screen] : []));
      const vars = { nonce: "kavoti", run: "lumeno" };
      for (const w of wanted)
        for (const g of given)
          expect(fillConformance(g, vars).replace(/\s+/g, "")).not.toContain(
            fillConformance(w, vars).replace(/\s+/g, ""),
          );
    }
  });

  test("the words of the ask check never consent to the commit they ask for (only `commit it` does)", () => {
    const ask = CONFORMANCE_CHECKS.find((c) => c.id === "hook-pre-tool-ask");
    const consent = CONFORMANCE_CHECKS.find((c) => c.id === "word-consent");
    const said = (c: typeof ask) => c?.steps.flatMap((s) => ("say" in s ? [s.say] : [])).join(" ") ?? "";
    expect(said(ask)).not.toMatch(/(^|[.,;!]\s*)commit\b/i);
    expect(said(consent)).toMatch(/^commit it,/);
  });

  test("fillConformance: the check's word as given and in uppercase, the run's word likewise", () => {
    expect(
      fillConformance("say {nonce}, expect {NONCE}; thread {run} / {RUN}", { nonce: "kavo", run: "lumi" }),
    ).toBe("say kavo, expect KAVO; thread lumi / LUMI");
    expect(fillConformance("cat {denied}", { nonce: "k", run: "r" })).toBe("cat {denied}");
    expect(fillConformance("cat {denied}", { nonce: "k", run: "r", denied: "/tmp/d/secret.txt" })).toBe(
      "cat /tmp/d/secret.txt",
    );
  });
});

describe("the HostConformance document and its report", () => {
  test("a run stamps and parses as HostConformance v2; a v1 run reads as one; evidence longer than the bound is refused", () => {
    const d = doc("claude", all("pass"));
    const stamped = HostConformanceDocument.stamp(d);
    expect([stamped.kind, stamped.schemaVersion]).toEqual(["HostConformance", 2]);
    expect(
      HostConformanceDocument.parse({ ...stamped, schemaVersion: 1 }, "v1.json")._unsafeUnwrap(),
    ).toEqual(d);
    const kept = { ...stamped, checks: [{ ...d.checks[0], from: "2026-11-20T10:00:00.000Z" }] };
    expect(HostConformanceDocument.parse(kept, "x.json")._unsafeUnwrap().checks[0]?.from).toBe(
      "2026-11-20T10:00:00.000Z",
    );
    // A v1 run had no `from`: it is refused there, as a v1 document never held one.
    expect(HostConformanceDocument.parse({ ...kept, schemaVersion: 1 }, "x.json").isErr()).toBe(true);
    expect(HostConformanceDocument.parse(stamped, "x.json")._unsafeUnwrap()).toEqual(d);
    const long = { ...stamped, checks: [{ ...d.checks[0], evidence: "x".repeat(EVIDENCE_MAX + 1) }] };
    expect(HostConformanceDocument.parse(long, "x.json").isErr()).toBe(true);
  });

  test("boundEvidence keeps the start and says it was cut", () => {
    expect(boundEvidence("short")).toBe("short");
    const cut = boundEvidence("y".repeat(EVIDENCE_MAX + 50));
    expect(cut.length).toBe(EVIDENCE_MAX);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("the report says the host, the version, the counts, each check with what it proves and its evidence", () => {
    const text = renderConformance(
      doc("copilot", { ...all("pass"), "session-id": "fail", tell: "skipped" }, { cliVersion: "1.0.114" }),
    );
    expect(text).toContain("# Host conformance: copilot 1.0.114");
    expect(text).toContain("10 passed, 1 failed, 1 skipped");
    expect(text).toContain("| session-id: MetatorAI knows the host's session id | FAIL | 2 s |");
    expect(text).toContain("## tell: skipped");
    expect(text).toContain("Proves: the person's words told to a run's idle session");
    expect(text).toContain("session-id: fail");
  });

  test("mergeConformance: the same host and version only; a never-played check is not carried over", () => {
    const before = doc(
      "claude",
      { ...all("pass"), tell: "fail", resume: "skipped" },
      { endedAt: "2026-11-20T10:00:00.000Z" },
    );
    const now = doc("claude", { ...all("skipped"), start: "pass" }, { endedAt: "2026-11-22T10:00:00.000Z" });
    const merged = mergeConformance(now, ["start"], before);
    const by = (id: string) => merged.checks.find((c) => c.id === id);
    expect([by("start")?.result, by("start")?.from]).toEqual(["pass", undefined]);
    expect([by("tell")?.result, by("tell")?.from]).toEqual(["fail", "2026-11-20T10:00:00.000Z"]);
    expect([by("resume")?.result, by("resume")?.from]).toEqual(["skipped", undefined]);
    expect(mergeConformance(now, ["start"], { ...before, cliVersion: "2.0.0" })).toEqual(now);
    expect(mergeConformance(now, ["start"], { ...before, host: "copilot" })).toEqual(now);
    expect(mergeConformance(now, ["start"], undefined)).toEqual(now);
  });

  test("mergeConformance: a check the machine could not hold was played: it is carried with its date, and the merged run still passes", () => {
    const before = doc("claude", { ...all("pass"), "sandbox-deny-read": "skipped" });
    const lacks = {
      ...before,
      checks: before.checks.map((c) =>
        c.id === "sandbox-deny-read" ? { ...c, evidence: `${MACHINE_LACKS}: bwrap is not installed` } : c,
      ),
    };
    const now = doc("claude", { ...all("skipped"), start: "pass" }, { endedAt: "2026-11-22T11:00:00.000Z" });
    const merged = mergeConformance(now, ["start"], lacks);
    const sandbox = merged.checks.find((c) => c.id === "sandbox-deny-read");
    expect([sandbox?.result, sandbox?.from, sandbox?.evidence.startsWith(MACHINE_LACKS)]).toEqual([
      "skipped",
      lacks.endedAt,
      true,
    ]);
    expect(conformancePassed(merged)).toBe(true);
  });

  test("conformancePassed: every check passed; a skipped or failed one is no pass, nor is an empty run", () => {
    expect(conformancePassed(doc("claude", all("pass")))).toBe(true);
    expect(conformancePassed(doc("claude", { ...all("pass"), tell: "skipped" }))).toBe(false);
    expect(conformancePassed(doc("claude", { ...all("pass"), tell: "fail" }))).toBe(false);
    expect(conformancePassed(doc("claude", {}))).toBe(false);
    // Skipped because the machine holds no sandbox: says nothing of the host. Not selected: no pass.
    const lacking = doc("claude", { ...all("pass"), "sandbox-deny-read": "skipped" });
    expect(conformancePassed(lacking)).toBe(false);
    const unheld = {
      checks: lacking.checks.map((c) =>
        c.id === "sandbox-deny-read" ? { ...c, evidence: `${MACHINE_LACKS}: bwrap is not installed` } : c,
      ),
    };
    expect(conformancePassed(unheld)).toBe(true);
    const tellUnheld = {
      checks: unheld.checks.map((c) =>
        c.id === "tell" ? { ...c, result: "skipped" as const, evidence: MACHINE_LACKS } : c,
      ),
    };
    expect(conformancePassed(tellUnheld)).toBe(false);
  });
});

describe("the diff of two hosts is the list of parity gaps", () => {
  test("every check whose result differs, in the suite's order, and nothing that is the same", () => {
    const a = doc("claude", all("pass"));
    const b = doc("copilot", {
      ...all("pass"),
      "session-id": "fail",
      "hook-pre-tool-ask": "fail",
      interrupt: "skipped",
    });
    expect(diffConformance(a, b)).toEqual([
      { id: "session-id", title: "MetatorAI knows the host's session id", a: "pass", b: "fail" },
      {
        id: "hook-pre-tool-ask",
        title: "The pre-tool hook's ask becomes the host's approval prompt",
        a: "pass",
        b: "fail",
      },
      {
        id: "interrupt",
        title: "`metator session interrupt` stops the work and is heard",
        a: "pass",
        b: "skipped",
      },
    ]);
    expect(diffConformance(a, a)).toEqual([]);
  });

  test("a check only one run has is missing on the other side", () => {
    const a = doc("claude", { start: "pass", later: "pass" });
    const b = doc("copilot", { start: "pass" });
    expect(diffConformance(a, b)).toEqual([{ id: "later", title: "later", a: "pass", b: "missing" }]);
  });
});

describe("versions", () => {
  test("cliVersionOf reads the version number a CLI prints, else its first line", () => {
    expect(cliVersionOf("2.1.329 (Claude Code)\n")).toBe("2.1.329");
    expect(cliVersionOf("GitHub Copilot CLI 1.0.114.\nCommit: abc")).toBe("1.0.114");
    expect(cliVersionOf("1.0.0-beta.2")).toBe("1.0.0-beta.2");
    expect(cliVersionOf("nightly build\n")).toBe("nightly build");
    expect(cliVersionOf("  ")).toBe("unknown");
  });

  test("compareVersions compares number by number", () => {
    expect(compareVersions("1.0.114", "1.0.99")).toBe(1);
    expect(compareVersions("1.0.9", "1.0.10")).toBe(-1);
    expect(compareVersions("2.1", "2.1.0")).toBe(0);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
  });

  test("conformanceFileName keeps the host and a version safe for a file name", () => {
    expect(conformanceFileName("claude", "2.1.329")).toBe("conformance-claude-2.1.329");
    expect(conformanceFileName("copilot", "1.0 (dev)/x")).toBe("conformance-copilot-1.0_dev_x");
  });
});

describe("what metator doctor says of the kept runs", () => {
  test("the last passing run per host, and the last run when it did not pass", () => {
    const seen = conformanceSeen([
      doc("claude", all("pass"), { cliVersion: "2.0.0", endedAt: "2026-11-01T10:00:00.000Z" }),
      doc("claude", all("pass"), { cliVersion: "2.1.0", endedAt: "2026-11-20T10:00:00.000Z" }),
      doc(
        "claude",
        { ...all("pass"), tell: "fail" },
        { cliVersion: "2.2.0", endedAt: "2026-11-21T10:00:00.000Z" },
      ),
      doc(
        "copilot",
        { ...all("pass"), resume: "fail" },
        { cliVersion: "1.0.114", endedAt: "2026-11-21T09:00:00.000Z" },
      ),
    ]);
    expect(seen).toEqual([
      {
        host: "claude",
        passed: { cliVersion: "2.1.0", at: "2026-11-20T10:00:00.000Z" },
        last: { cliVersion: "2.2.0", at: "2026-11-21T10:00:00.000Z", failed: 1 },
      },
      { host: "copilot", last: { cliVersion: "1.0.114", at: "2026-11-21T09:00:00.000Z", failed: 1 } },
    ]);
  });

  test("passed with this version or an older one: ok; an older version installed: a warning only; never passed: a warning", () => {
    const passed = { host: "claude", passed: { cliVersion: "2.1.0", at: "2026-11-20T10:00:00.000Z" } };
    expect(conformanceLine(passed)).toEqual({
      status: "ok",
      message: "last passed with claude 2.1.0 on 2026-11-20",
    });
    expect(conformanceLine({ ...passed, installed: "2.3.0" }).status).toBe("ok");
    expect(conformanceLine({ ...passed, installed: "2.0.9" })).toEqual({
      status: "warn",
      message: "last passed with claude 2.1.0 on 2026-11-20; claude 2.0.9 installed here is older",
      fix: "metator host conformance --host claude",
    });
    expect(
      conformanceLine({
        host: "copilot",
        last: { cliVersion: "1.0.114", at: "2026-11-21T09:00:00.000Z", failed: 3 },
      }),
    ).toEqual({
      status: "warn",
      message:
        "copilot: the suite never passed here (last run with 1.0.114 on 2026-11-21: 3 check(s) did not pass)",
      fix: "metator host conformance --host copilot",
    });
  });
});
