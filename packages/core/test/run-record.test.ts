import { describe, expect, test } from "bun:test";
import { fillInputs, pendingResume, RunRecordDocument, resumableStages } from "../src/domain/run-record.ts";

describe("fillInputs", () => {
  test("{name} is the run's value, {name|default} falls back, {runDir} is left to the drive", () => {
    expect(
      fillInputs("metator review plan --base {base|HEAD} --out {runDir}/p.json", {
        base: "main",
      })._unsafeUnwrap(),
    ).toBe("metator review plan --base main --out {runDir}/p.json");
    expect(fillInputs("metator review plan --base {base|HEAD}", {})._unsafeUnwrap()).toBe(
      "metator review plan --base HEAD",
    );
    // git's revision syntax is no input: the publish gate compares with the upstream.
    expect(fillInputs("git diff --quiet @{u}", {})._unsafeUnwrap()).toBe("git diff --quiet @{u}");
    expect(fillInputs("git show HEAD@{upstream} {base}", { base: "main" })._unsafeUnwrap()).toBe(
      "git show HEAD@{upstream} main",
    );
    expect(fillInputs("x {base} {base}", { base: "origin/main" })._unsafeUnwrap()).toBe(
      "x origin/main origin/main",
    );
  });

  test("an input with no value and no default is an error that says how to start the run", () => {
    const error = fillInputs("metator review plan --base {base} --pr {pr|}", {})._unsafeUnwrapErr();
    expect([error.code, error.message, error.hint]).toEqual([
      "USAGE",
      "the script needs the input `base`, `pr`: metator review plan --base {base} --pr {pr|}",
      "Start the run with --input base=<value> --input pr=<value>.",
    ]);
  });
});

describe("RunRecord v5", () => {
  const v4 = {
    kind: "RunRecord",
    schemaVersion: 4,
    runId: "20261030-mt-pr-review-x",
    workflow: { id: "mt-pr-review", revision: 6, source: ".github/metator/workflows/mt-pr-review.yml" },
    task: "Review",
    autonomy: "L0",
    createdAt: "2026-10-30T05:52:07.002Z",
    updatedAt: "2026-10-30T05:52:07.002Z",
    state: {
      workflow: "mt-pr-review",
      stage: "metadata",
      status: "active",
      context: { loops: {}, history: [] },
    },
    approvals: {},
  };

  test("a v4 record reads as a v5 record started without inputs", () => {
    const r = RunRecordDocument.parse(v4, "state.json")._unsafeUnwrap();
    expect([r.runId, r.inputs]).toEqual(["20261030-mt-pr-review-x", undefined]);
  });

  test("input names are lower-case identifiers and values are not empty", () => {
    const at = (inputs: Record<string, string>) =>
      RunRecordDocument.parse({ ...v4, schemaVersion: 5, inputs }, "state.json").isOk();
    expect([at({ base: "main" }), at({ Base: "main" }), at({ base: "" })]).toEqual([true, false, false]);
  });
});

describe("RunRecord v8: resumes", () => {
  const v7 = {
    kind: "RunRecord",
    schemaVersion: 7,
    runId: "20261030-feature-x",
    workflow: { id: "feature", revision: 1, source: ".github/metator/workflows/feature.yml" },
    task: "x",
    autonomy: "L0",
    createdAt: "2026-10-30T05:52:07.002Z",
    updatedAt: "2026-10-30T05:52:07.002Z",
    state: {
      workflow: "feature",
      stage: "plan",
      status: "active",
      context: {
        loops: {},
        history: [
          { stage: "plan", event: "PASS" },
          { stage: "build", event: "FAIL", detail: "red" },
        ],
      },
    },
    approvals: {},
    options: { "supervisor.wipLimit": 1 },
  };
  const resume = { at: "2026-10-30T06:00:00.000Z", by: "ala", from: "build", to: "plan", after: 2 };

  test("a v7 record reads as a v8 record nobody resumed; a resume names who, where and when", () => {
    const old = RunRecordDocument.parse(v7, "state.json")._unsafeUnwrap();
    expect([RunRecordDocument.current, old.resumes, old.options]).toEqual([
      8,
      undefined,
      { "supervisor.wipLimit": 1 },
    ]);
    const at = (r: object) =>
      RunRecordDocument.parse({ ...v7, schemaVersion: 8, resumes: [r] }, "state.json").isOk();
    expect([
      at({ ...resume, note: "smaller steps" }),
      at(resume),
      at({ ...resume, by: "" }),
      at({ ...resume, note: "" }),
      at({ ...resume, after: -1 }),
      at({ ...resume, extra: 1 }),
    ]).toEqual([true, true, false, false, false, false]);
    // v7 itself never learns the field.
    expect(RunRecordDocument.parse({ ...v7, resumes: [resume] }, "state.json").isErr()).toBe(true);
  });

  test("a resume is pending until the run records a transition that is not an approval", () => {
    const record = RunRecordDocument.parse(
      { ...v7, schemaVersion: 8, resumes: [{ ...resume, after: 1 }, resume] },
      "state.json",
    )._unsafeUnwrap();
    expect(pendingResume(record)).toEqual(resume);
    const withHistory = (...more: { stage: string; event: "PASS" | "FAIL" | "APPROVE" | "ABORT" }[]) => ({
      ...record,
      state: {
        ...record.state,
        context: { ...record.state.context, history: [...record.state.context.history, ...more] },
      },
    });
    // A gate a person approved ran no agent: the note still waits for the stage after it.
    expect(pendingResume(withHistory({ stage: "approval", event: "APPROVE" }))).toEqual(resume);
    expect(pendingResume(withHistory({ stage: "plan", event: "PASS" }))).toBeUndefined();
    expect(
      pendingResume(withHistory({ stage: "approval", event: "APPROVE" }, { stage: "build", event: "FAIL" })),
    ).toBeUndefined();
    expect(pendingResume({ ...record, state: { ...record.state, status: "escalated" } })).toBeUndefined();
    expect(pendingResume({ state: record.state })).toBeUndefined();
  });

  test("the stages a resume may go on at: the ones the run worked, in the workflow's order", () => {
    const history = [{ stage: "build" }, { stage: "plan" }, { stage: "build" }, { stage: "gone" }];
    expect(resumableStages(["plan", "gate", "build", "ship"], history)).toEqual(["plan", "build"]);
    expect(resumableStages(["plan"], [])).toEqual([]);
  });
});
