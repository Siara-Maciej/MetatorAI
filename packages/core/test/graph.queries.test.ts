import { describe, expect, test } from "bun:test";
import { DependencyGraph, type Edge } from "../src/domain/graph.ts";

const edge = (from: string, to: string): Edge => ({ from, to, kind: "internal" });

describe("DependencyGraph.cycles", () => {
  test("acyclic graph has no cycles", () => {
    expect(new DependencyGraph([edge("a", "b"), edge("b", "c")]).cycles()).toEqual([]);
  });

  test("reports each import cycle once, members sorted", () => {
    const graph = new DependencyGraph([
      edge("a", "b"),
      edge("b", "a"),
      edge("c", "d"),
      edge("d", "e"),
      edge("e", "c"),
      edge("x", "a"),
    ]);
    const cycles = graph.cycles().sort((p, q) => p.length - q.length);
    expect(cycles).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
    ]);
  });

  test("self-import counts as a cycle", () => {
    expect(new DependencyGraph([edge("a", "a")]).cycles()).toEqual([["a"]]);
  });
});

describe("DependencyGraph.path", () => {
  const graph = new DependencyGraph([
    edge("ui", "service"),
    edge("service", "repo"),
    edge("ui", "repo"),
    edge("repo", "db"),
  ]);

  test("returns the shortest dependency chain", () => {
    expect(graph.path("ui", "db")).toEqual(["ui", "repo", "db"]);
    expect(graph.path("service", "db")).toEqual(["service", "repo", "db"]);
  });

  test("a file trivially reaches itself", () => {
    expect(graph.path("repo", "repo")).toEqual(["repo"]);
  });

  test("no path against the dependency direction or for unknown files", () => {
    expect(graph.path("db", "ui")).toBeUndefined();
    expect(graph.path("ui", "nope")).toBeUndefined();
    expect(graph.path("nope", "ui")).toBeUndefined();
  });
});
