import { describe, expect, test } from "bun:test";
import { fillInputs, RunRecordDocument } from "../src/domain/run-record.ts";

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
