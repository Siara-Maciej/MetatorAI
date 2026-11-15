import { describe, expect, test } from "bun:test";
import { driveHostOf } from "../src/domain/drive.ts";
import { systemGate } from "../src/domain/system-gate.ts";

const step = (id: string, app: string, status: string, run?: { status: string; stage: string }) => ({
  id,
  app,
  status: status as "pending",
  ...(run ? { run: `r-${id}`, runStatus: run.status, stage: run.stage } : {}),
});
const HOUR = 3_600_000;

describe("the gate of a system run that waits on its children (systemGate)", () => {
  test("every step done: it passes", () => {
    expect(
      systemGate({ steps: [step("a", "shop-api", "done")], ready: [], waitedMs: 0, timeoutMs: HOUR }),
    ).toEqual({
      kind: "pass",
      message: "every step is done",
    });
  });

  test("children still working or not started: it waits, and says which", () => {
    const g = systemGate({
      steps: [
        step("a", "shop-api", "running", { status: "active", stage: "build" }),
        step("b", "shop-web", "pending"),
      ],
      ready: [],
      waitedMs: 1000,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({
      kind: "waiting",
      message: "waiting on children: shop-api working at build, shop-web not started",
    });
  });

  test("a step that can start now sends the run back to start it: a new wave", () => {
    const g = systemGate({
      steps: [step("a", "shop-api", "done"), step("b", "shop-web", "pending")],
      ready: ["b"],
      waitedMs: 0,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({ kind: "wave", message: "a step can start: b" });
  });

  test("a child escalated or aborted: blocked at once, naming the run and where to resolve it", () => {
    const g = systemGate({
      steps: [
        step("a", "shop-api", "blocked", { status: "escalated", stage: "build" }),
        step("b", "shop-web", "running", { status: "active", stage: "plan" }),
      ],
      ready: [],
      waitedMs: 0,
      timeoutMs: HOUR,
    });
    expect(g).toEqual({
      kind: "blocked",
      message: "step a is blocked: its run r-a in shop-api escalated at build",
      hint: "Resolve that run in shop-api (resume or close it), then resume this run.",
    });
  });

  test("waiting longer than the timeout: blocked, with how long it waited", () => {
    const g = systemGate({
      steps: [step("a", "shop-api", "running", { status: "active", stage: "build" })],
      ready: [],
      waitedMs: 7 * HOUR,
      timeoutMs: 6 * HOUR,
    });
    expect(g.kind).toBe("blocked");
    expect(g.message).toBe("waited 7 h for the children, longer than 6 h: shop-api working at build");
  });
});

describe("the host a drive takes when nobody names one (driveHostOf)", () => {
  const known = ["copilot", "claude", "scenario"];
  test("METATOR_HOST, else the first of supervisor.hostOrder that can start here, else the first target", () => {
    const pick = (o: Partial<Parameters<typeof driveHostOf>[0]>) =>
      driveHostOf({ order: [], targets: [], known, ...o });
    expect(pick({ chosen: "scenario", order: ["claude"] })).toBe("scenario");
    expect(pick({ order: ["scenario", "claude"], targets: ["claude"] })).toBe("scenario");
    // A host of the order that cannot start here (its program is not installed) is passed over.
    expect(
      pick({ order: ["copilot", "claude"], problem: (h) => (h === "copilot" ? "not installed" : undefined) }),
    ).toBe("claude");
    // One the runtime does not drive agents with is passed over too; then the targets, then the first known.
    expect(pick({ order: ["opencode"], targets: ["claude"] })).toBe("claude");
    expect(pick({ chosen: "nope", order: [], targets: [] })).toBe("copilot");
  });
});
