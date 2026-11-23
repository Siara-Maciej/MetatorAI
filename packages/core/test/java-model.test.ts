import { describe, expect, test } from "bun:test";
import { annotationNamed, rawType, simpleTypeName, stringValues, typeArguments } from "../src/index.ts";

describe("Java type names as written", () => {
  test("type arguments split at the top level only; raw and simple names drop arguments and arrays", () => {
    expect(typeArguments("Map<K,List<V>>")).toEqual(["K", "List<V>"]);
    expect(typeArguments("Map<String, Map<Long, Set<X>>>")).toEqual(["String", "Map<Long, Set<X>>"]);
    expect(typeArguments("String")).toEqual([]);
    expect(rawType("List<Order>[]")).toBe("List");
    expect(rawType("String...")).toBe("String");
    expect(simpleTypeName("java.util.Map.Entry<K,V>")).toBe("Entry");
  });

  test("annotations match by simple name; string arguments are literals or arrays of them", () => {
    const a = { name: "jakarta.persistence.Entity", arguments: {}, line: 1 };
    expect(annotationNamed([a], "Entity")).toBe(a);
    expect(annotationNamed([a], "Table")).toBeUndefined();
    expect(stringValues({ text: '"/a"', value: "/a" })).toEqual(["/a"]);
    expect(
      stringValues({
        text: "{}",
        items: [
          { text: '"a"', value: "a" },
          { text: '"b"', value: "b" },
        ],
      }),
    ).toEqual(["a", "b"]);
    expect(stringValues({ text: "X.Y" })).toBeUndefined();
  });
});
