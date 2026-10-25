import { describe, expect, test } from "bun:test";
import { DependencyGraph, type Edge } from "../src/domain/graph.ts";

const edge = (from: string, to: string, kind: Edge["kind"] = "internal"): Edge => ({ from, to, kind });

describe("DependencyGraph.affected", () => {
  test("includes changed files and transitive dependents", () => {
    // ui -> service -> repo ; test -> service
    const graph = new DependencyGraph([
      edge("ui.ts", "service.ts"),
      edge("service.ts", "repo.ts"),
      edge("service.test.ts", "service.ts"),
    ]);
    expect([...graph.affected(["repo.ts"])].sort()).toEqual([
      "repo.ts",
      "service.test.ts",
      "service.ts",
      "ui.ts",
    ]);
  });

  test("does not include dependencies of the changed file", () => {
    const graph = new DependencyGraph([edge("a.ts", "b.ts")]);
    expect([...graph.affected(["a.ts"])]).toEqual(["a.ts"]);
  });

  test("terminates on cycles", () => {
    const graph = new DependencyGraph([edge("a.ts", "b.ts"), edge("b.ts", "a.ts")]);
    expect([...graph.affected(["a.ts"])].sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("ignores external edges", () => {
    const graph = new DependencyGraph([edge("a.ts", "lodash", "external")]);
    expect([...graph.affected(["lodash"])]).toEqual(["lodash"]);
    expect(graph.dependenciesOf("a.ts").size).toBe(0);
  });

  test("unknown changed file is reported as affected on its own", () => {
    expect([...new DependencyGraph([]).affected(["new.ts"])]).toEqual(["new.ts"]);
  });

  test("random DAGs: every affected file reaches a changed file (property check)", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let run = 0; run < 50; run++) {
      const n = 3 + Math.floor(rand() * 15);
      const edges: Edge[] = [];
      for (let i = 0; i < n; i++)
        for (let j = 0; j < i; j++) if (rand() < 0.25) edges.push(edge(`f${i}`, `f${j}`));
      const graph = new DependencyGraph(edges);
      const changed = [`f${Math.floor(rand() * n)}`];
      for (const file of graph.affected(changed)) {
        expect(reaches(graph, file, new Set(changed))).toBe(true);
      }
    }
  });
});

function reaches(
  graph: DependencyGraph,
  from: string,
  targets: Set<string>,
  seen = new Set<string>(),
): boolean {
  if (targets.has(from)) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return [...graph.dependenciesOf(from)].some((dep) => reaches(graph, dep, targets, seen));
}
