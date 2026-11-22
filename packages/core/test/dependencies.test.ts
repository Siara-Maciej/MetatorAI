import { describe, expect, test } from "bun:test";
import { readyItems, unmetDependencies } from "../src/domain/dependencies.ts";
import { readySteps } from "../src/domain/system-plan.ts";

interface Item {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly state: "waiting" | "done" | "running";
}
const item = (id: string, state: Item["state"], dependsOn: string[] = []): Item => ({ id, dependsOn, state });
const done = (i: Item) => i.state === "done";
const waiting = (i: Item) => i.state === "waiting";

describe("the dependency rule (ADR-0071 steps, ADR-0096 Backlog children)", () => {
  test("an item waits for each dependency that is not done, in the order it names them", () => {
    const items = [item("a", "done"), item("b", "running"), item("c", "waiting", ["b", "a", "d"])];
    // `d` is no item: an unknown dependency is never done.
    expect(unmetDependencies(items[2] as Item, items, done)).toEqual(["b", "d"]);
    expect(unmetDependencies(item("x", "waiting", ["a"]), items, done)).toEqual([]);
  });

  test("ready: waiting, with every dependency done", () => {
    const items = [
      item("a", "done"),
      item("b", "waiting", ["a"]),
      item("c", "waiting", ["b"]),
      item("d", "running"),
      item("e", "waiting"),
    ];
    expect(readyItems(items, done, waiting).map((i) => i.id)).toEqual(["b", "e"]);
  });

  test("readySteps is the same rule over a system plan's steps", () => {
    const step = (id: string, status: "pending" | "done" | "running", dependsOn: string[] = []) => ({
      id,
      app: "web",
      summary: id,
      contracts: [],
      dependsOn,
      status,
    });
    const plan = { steps: [step("a", "done"), step("b", "pending", ["a"]), step("c", "pending", ["b"])] };
    expect(readySteps(plan).map((s) => s.id)).toEqual(["b"]);
  });
});
