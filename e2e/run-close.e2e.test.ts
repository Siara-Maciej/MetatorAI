/** `run handoff` and `run close` end to end: real `metator` processes on a real git repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const FEATURE = `kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: plan
  - id: approval
    hitl: true
  - id: build
`;
const AT = (t: string) => ({ METATOR_NOW: `2026-10-26T${t}:00.000Z` });

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".github/metator/workflows/feature.yml", FEATURE);
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator run handoff|close (real CLI)", () => {
  test("handoff, then close a finished run with its telemetry", async () => {
    const init = await metator(
      ["run", "init", "--workflow", "feature", "--task", "Add discount"],
      repo.root,
      AT("09:00"),
    );
    const runId = (init.json.data as { runId: string }).runId;
    await metator(["run", "advance", "pass"], repo.root, AT("09:10"));
    await metator(["run", "advance", "approve", "--by", "maciej"], repo.root, AT("09:20"));
    await repo.write(`.metator/runs/${runId}/plan.json`, '{"kind":"Plan","schemaVersion":1}');

    const handoff = await metator(["run", "handoff", "--log-lines", "3"], repo.root, AT("09:30"));
    expect([handoff.code, handoff.json.data]).toEqual([
      0,
      { runId, file: `.metator/runs/${runId}/handoff.md`, artifacts: ["plan.json"] },
    ]);
    const doc = await repo.read(`.metator/runs/${runId}/handoff.md`);
    expect(doc).toStartWith(`---\nkind: RunHandoff\nschemaVersion: 1\nrunId: ${runId}\n`);
    expect(doc).toContain("- Stage: build (active)");
    expect(doc).toContain("- approval: maciej, 2026-10-26T09:20:00.000Z");

    const early = await metator(["run", "close"], repo.root, AT("09:40"));
    expect([early.code, (early.json.error as { code: string }).code]).toEqual([64, "USAGE"]);

    await metator(["run", "advance", "pass"], repo.root, AT("09:50"));
    const close = await metator(["run", "close", "--run", runId], repo.root, AT("10:00"));
    expect(close.code).toBe(0);
    expect(close.json.data).toMatchObject({
      status: "done",
      durationMs: 3_600_000,
      events: { PASS: 2, APPROVE: 1, FAIL: 0, ABORT: 0 },
      artifacts: ["plan.json"],
    });
    const summary = JSON.parse(await repo.read(`.metator/runs/${runId}/summary.json`));
    expect([summary.kind, summary.schemaVersion]).toEqual(["RunSummary", 1]);
    expect((await findUnversioned(repo.root, [".metator", ".github/metator"])).unversioned).toEqual([]);
  }, 60_000);

  test("--aborted needs a reason; with one it aborts and closes the active run", async () => {
    await metator(["run", "init", "--workflow", "feature", "--task", "Drop it"], repo.root, AT("11:00"));
    const bare = await metator(["run", "close", "--aborted"], repo.root, AT("11:05"));
    expect([bare.code, (bare.json.error as { message: string }).message]).toEqual([
      64,
      "--aborted needs --reason <text>",
    ]);
    const r = await metator(
      ["run", "close", "--aborted", "--reason", "scope changed"],
      repo.root,
      AT("11:10"),
    );
    expect([r.code, (r.json.data as { status: string }).status]).toEqual([0, "aborted"]);
    const status = await metator(["run", "status"], repo.root);
    expect((status.json.data as { status: string }).status).toBe("aborted");
  }, 60_000);
});

describe("metator run schema (real CLI)", () => {
  test("prints the format of each worker artifact; an unknown artifact is a usage error", async () => {
    const kinds: [string, string][] = [
      ["analysis", "Analysis"],
      ["research", "Research"],
      ["plan.json", "Plan"],
      ["plan-scope.json", "PlanScope"],
      ["verdict", "Verdict"],
      ["findings", "FindingSet"],
      ["summary", "RunSummary"],
    ];
    for (const [artifact, kind] of kinds) {
      const r = await metator(["run", "schema", artifact], repo.root);
      const schema = r.json.data as { properties: { kind: { const: string } } };
      expect([r.code, schema.properties.kind.const]).toEqual([0, kind]);
    }
    expect((await metator(["run", "schema", "notes"], repo.root)).code).toBe(64);
    // gates.md is prose: the gate's own report is the structured one.
    expect((await metator(["run", "schema", "gates.json"], repo.root)).code).toBe(64);
  }, 60_000);
});

describe("metator run: autopilot (real CLI)", () => {
  test("choosing autopilot at the plan gate skips later L1 gates, never the push gate", async () => {
    await repo.write(
      ".github/metator/workflows/gated.yml",
      `kind: Workflow
schemaVersion: 2
id: gated
autonomy: [L0, L1]
stages:
  - id: plan-approval
    hitl: true
    skipAt: [L1]
  - id: build
  - id: review-approval
    hitl: true
    skipAt: [L1]
  - id: delivery
    hitl: true
    neverSkip: true
`,
    );
    await metator(["run", "init", "--workflow", "gated", "--task", "Autopilot"], repo.root, AT("12:00"));
    const approved = await metator(
      ["run", "approve", "plan-approval", "--by", "maciej", "--choice", "autopilot"],
      repo.root,
      AT("12:01"),
    );
    expect([approved.code, (approved.json.data as { autonomy: string }).autonomy]).toEqual([0, "L1"]);
    const built = await metator(["run", "advance", "pass"], repo.root, AT("12:02"));
    const view = built.json.data as { stage: string; approvals: Record<string, { by: string }> };
    expect([view.stage, view.approvals["review-approval"]?.by]).toEqual(["delivery", "autonomy L1"]);
    // Autopilot never covers external actions: a push still needs `run approve push`.
    const push = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git push" } },
      repo.root,
    );
    expect(
      (push.json?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
    ).toBe("deny");
  }, 60_000);
});
