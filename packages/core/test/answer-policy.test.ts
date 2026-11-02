import { describe, expect, test } from "bun:test";
import {
  type AnswerPolicy,
  AnswerPolicyStore,
  matchPolicy,
  policyFrom,
  policyRefusal,
  type Question,
} from "@metator/core";
import { InMemoryFileSystem } from "@metator/testing";

const gate = (over: Partial<Question> = {}): Question => ({
  id: "q001",
  runId: "r",
  stage: "plan-approval",
  source: "gate",
  prompt: "The human approves the plan: approve to continue",
  options: [{ label: "Approve" }, { label: "Reject" }, { label: "Other" }],
  multiSelect: false,
  askedAt: "2026-11-02T10:00:00.000Z",
  card: { task: "t", done: ["plan"], artifacts: [], recommended: "Approve", reversible: true },
  ...over,
});
const policy = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
  id: "approve-plan",
  when: { source: "gate", stage: "plan-approval", recommended: "Approve" },
  answer: { choices: ["Approve"] },
  by: "alice",
  at: "2026-11-02T10:00:00.000Z",
  ...over,
});

describe("answer policies", () => {
  test("a policy answers the question it was made for, only while the card recommends the same", () => {
    expect(matchPolicy([policy()], gate())?.id).toBe("approve-plan");
    // The plan gate failed before: the card recommends nothing, so a person decides.
    expect(
      matchPolicy([policy()], gate({ card: { task: "t", done: [], artifacts: [], reversible: true } })),
    ).toBe(undefined);
    expect(matchPolicy([policy()], gate({ stage: "delivery" }))).toBeUndefined();
    expect(matchPolicy([policy({ when: { source: "agent" } })], gate())).toBeUndefined();
    expect(
      matchPolicy([policy({ when: { source: "gate", agent: "mt-planner" } })], gate({ agent: "mt-scout" })),
    ).toBeUndefined();
    expect(matchPolicy([policy({ answer: { choices: ["Maybe"] } })], gate())).toBeUndefined();
  });

  test("never where a wrong answer costs more than a question: a push, allowing a tool, words", () => {
    const push = gate({ stage: "delivery", card: { task: "t", done: [], artifacts: [], reversible: false } });
    expect(policyRefusal(push, ["Approve"])).toContain("cannot be taken back");
    expect(matchPolicy([policy({ when: { source: "gate" } })], push)).toBeUndefined();
    const tool = gate({ source: "permission", options: [{ label: "Allow" }, { label: "Deny" }] });
    expect(policyRefusal(tool, ["Allow"])).toContain("never allow one");
    expect(policyRefusal(tool, ["Deny"])).toBeUndefined();
    expect(policyRefusal(gate(), ["Other"])).toContain("own words");
    expect(policyRefusal(gate(), ["Reject"])).toContain("own words");
    // A command it denies, by the text of the prompt.
    const deny = policy({
      id: "no-npx",
      when: { source: "permission", promptIncludes: "npx " },
      answer: { choices: ["Deny"], text: "use metator test" },
    });
    expect(matchPolicy([deny], { ...tool, prompt: "Bash: npx vitest run" })?.id).toBe("no-npx");
    expect(matchPolicy([deny], { ...tool, prompt: "Bash: ls" })).toBeUndefined();
  });

  test("a person's answer becomes a policy for the same question, with a free id", () => {
    const p = policyFrom(
      gate({ agent: "mt-x" }),
      { choices: ["Approve"] },
      "alice",
      "2026-11-02T11:00:00.000Z",
      ["gate-plan-approval-approve"],
    );
    expect(p).toEqual({
      id: "gate-plan-approval-approve-2",
      when: { source: "gate", stage: "plan-approval", agent: "mt-x", recommended: "Approve" },
      answer: { choices: ["Approve"] },
      by: "alice",
      at: "2026-11-02T11:00:00.000Z",
    });
  });

  test("the store keeps policies in metator/answer-policies.yml: added, listed, removed", async () => {
    const fs = new InMemoryFileSystem();
    const store = new AnswerPolicyStore(fs);
    expect((await store.list())._unsafeUnwrap()).toEqual([]);
    await store.add(policy());
    expect((await store.add(policy()))._unsafeUnwrapErr().message).toBe(
      "answer policy approve-plan exists already",
    );
    const text = (await fs.read("metator/answer-policies.yml"))._unsafeUnwrap();
    expect(text).toStartWith("# Answer policies");
    expect(text).toContain("kind: AnswerPolicies");
    expect((await store.list())._unsafeUnwrap().map((p) => p.id)).toEqual(["approve-plan"]);
    expect((await store.remove("approve-plan"))._unsafeUnwrap().id).toBe("approve-plan");
    expect((await store.remove("approve-plan"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect((await store.list())._unsafeUnwrap()).toEqual([]);
  });
});
