import { describe, expect, test } from "bun:test";
import { parseWorkflowYaml, validateWorkflowSpec, workflowJsonSchema } from "../src/domain/workflow-spec.ts";

const yaml = `
kind: Workflow
schemaVersion: 1
id: mt-feature
description: Feature workflow
stages:
  - id: context
  - id: plan
  - id: plan-gate
    onFail: { goto: plan, loop: plan }
  - id: approval
    hitl: true
loops:
  plan: 2
`;

describe("workflow spec", () => {
  test("parses YAML and applies defaults", () => {
    const spec = parseWorkflowYaml(yaml, "feature.yml")._unsafeUnwrap();
    expect(spec.id).toBe("mt-feature");
    expect(spec.revision).toBe(1);
    expect(spec.stages.map((s) => s.id)).toEqual(["context", "plan", "plan-gate", "approval"]);
    expect(spec.loops).toEqual({ plan: 2 });
    expect(validateWorkflowSpec({ id: "w", stages: [{ id: "a" }] })._unsafeUnwrap().loops).toEqual({});
  });

  test("malformed YAML is an INVALID_CONFIG error naming the file", () => {
    const error = parseWorkflowYaml(
      "kind: Workflow\nschemaVersion: 1\nid: [unclosed",
      "broken.yml",
    )._unsafeUnwrapErr();
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("broken.yml");
  });

  test("unknown keys are rejected (typos must not be silently ignored)", () => {
    const error = parseWorkflowYaml(
      "kind: Workflow\nschemaVersion: 1\nid: w\nstages: [{ id: a, hitll: true }]",
      "w.yml",
    )._unsafeUnwrapErr();
    expect(JSON.stringify(error.details)).toContain("hitll");
  });

  test("reports every issue with its path", () => {
    const error = validateWorkflowSpec(
      {
        id: "Bad Id",
        stages: [{ id: "a", onFail: { goto: "zz", loop: "retry" } }, { id: "a" }, { id: "done" }],
      },
      "x.yml",
    )._unsafeUnwrapErr();
    const issues = (error.details as { issues: { path: string; message: string }[] }).issues;
    const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
    expect(byPath.id).toContain("lowercase");
    expect(byPath["stages.0.onFail.goto"]).toContain('unknown stage "zz"');
    expect(byPath["stages.0.onFail.loop"]).toContain("add loops.retry");
    expect(byPath["stages.1.id"]).toContain("Duplicate");
    expect(byPath["stages.2.id"]).toContain("reserved");
    expect(error.hint).toContain("metator workflow schema");
  });

  test("negative loop limits and empty stage lists are invalid", () => {
    expect(validateWorkflowSpec({ id: "w", stages: [] }).isErr()).toBe(true);
    expect(validateWorkflowSpec({ id: "w", stages: [{ id: "a" }], loops: { x: -1 } }).isErr()).toBe(true);
  });

  test("exposes a JSON Schema for agents and editors", () => {
    const schema = workflowJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["id", "stages"]));
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["kind", "schemaVersion", "id", "stages", "loops", "revision"]),
    );
  });
});

describe("shipped workflows", () => {
  test("a person who rejects a plan sends it back to the planner with the reason", async () => {
    for (const id of ["mt-feature", "mt-bugfix", "mt-refactor"]) {
      const file = `${import.meta.dir}/../../../.github/metator/workflows/${id}.yml`;
      const spec = parseWorkflowYaml(await Bun.file(file).text(), file)._unsafeUnwrap();
      const approval = spec.stages.find((s) => s.id === "plan-approval");
      expect([id, approval?.hitl, approval?.onFail?.goto]).toEqual([id, true, "plan"]);
      // Approving the delivery approves the push; publish is done only when the branch is pushed.
      const delivery = spec.stages.find((s) => s.id === "delivery");
      const publish = spec.stages.find((s) => s.id === "publish");
      expect([delivery?.grants, publish?.gate?.script, publish?.onFail?.goto]).toEqual([
        ["push"],
        "metator run published",
        "publish",
      ]);
    }
  });
});

describe("workflow v3: grants", () => {
  const v = (stage: string, schemaVersion = 3) =>
    `kind: Workflow\nschemaVersion: ${schemaVersion}\nid: w\nstages:\n  - id: build\n${stage}`;
  test("a human gate may grant external actions; a v2 file is a v3 file", () => {
    const spec = parseWorkflowYaml(v("  - id: delivery\n    hitl: true\n    grants: [push]\n"), "w.yml");
    expect(spec._unsafeUnwrap().stages[1]?.grants).toEqual(["push"]);
    expect(parseWorkflowYaml(v("  - id: delivery\n    hitl: true\n", 2), "w.yml").isOk()).toBe(true);
  });
  test("only a human gate grants, and only push or comment; a v2 file cannot", () => {
    const notGate = parseWorkflowYaml(v("  - id: publish\n    grants: [push]\n"), "w.yml");
    expect(notGate._unsafeUnwrapErr().message).toContain('Stage "publish" grants push but is no human gate');
    expect(parseWorkflowYaml(v("  - id: d\n    hitl: true\n    grants: [deploy]\n"), "w.yml").isErr()).toBe(
      true,
    );
    expect(parseWorkflowYaml(v("  - id: d\n    hitl: true\n    grants: [push]\n", 2), "w.yml").isErr()).toBe(
      true,
    );
  });
});
