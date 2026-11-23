import { describe, expect, test } from "bun:test";
import { allTypes } from "@metator/core";
import { normalizeType, TreeSitterJavaParser, textBlock } from "../src/tree-sitter-java-parser.ts";

const parser = new TreeSitterJavaParser();
const parse = async (src: string) => (await parser.parse("A.java", src))._unsafeUnwrap();

describe("TreeSitterJavaParser", () => {
  test("package, imports (single, on-demand, static) and a class with its members", async () => {
    const f = await parse(`package com.example.api;

import java.util.List;
import java.util.*;
import static org.x.Y.CONST;
import static org.x.Z.*;

@RestController
@RequestMapping(value = {"/a", "/b"}, method = RequestMethod.GET)
public final class OrderController<T extends Comparable<T>> extends Base<T> implements Api, Other {
  @Autowired private final List<String> names = List.of();
  public static final String BASE = "/api" + "/v1";
  public OrderController(@Value("\${a:b}") String s) throws java.io.IOException {}
  @GetMapping("/x")
  public ResponseEntity<Map<String, Long>> get(@PathVariable("id") Long id, String... rest) throws A, B { return null; }
}
`);
    expect(f.package).toBe("com.example.api");
    expect(f.imports).toEqual([
      { name: "java.util.List", static: false, onDemand: false, line: 3 },
      { name: "java.util", static: false, onDemand: true, line: 4 },
      { name: "org.x.Y.CONST", static: true, onDemand: false, line: 5 },
      { name: "org.x.Z", static: true, onDemand: true, line: 6 },
    ]);
    const t = f.types[0];
    expect(t).toMatchObject({
      name: "OrderController",
      qualifiedName: "com.example.api.OrderController",
      kind: "class",
      line: 10,
      modifiers: ["public", "final"],
      typeParameters: ["T extends Comparable<T>"],
      extends: ["Base<T>"],
      implements: ["Api", "Other"],
    });
    expect(t?.annotations.map((a) => a.name)).toEqual(["RestController", "RequestMapping"]);
    const mapping = t?.annotations[1];
    expect(mapping?.arguments.value?.items?.map((i) => i.value)).toEqual(["/a", "/b"]);
    expect(mapping?.arguments.method?.text).toBe("RequestMethod.GET");
    expect(t?.fields[0]).toMatchObject({
      name: "names",
      type: "List<String>",
      modifiers: ["private", "final"],
      line: 11,
    });
    expect(t?.fields[0]?.value).toBeUndefined(); // not a literal
    expect(t?.fields[1]).toMatchObject({ name: "BASE", value: { value: "/api/v1" } });
    expect(t?.constructors[0]).toMatchObject({ throws: ["java.io.IOException"], line: 13 });
    expect(t?.constructors[0]?.parameters[0]?.annotations[0]?.arguments.value?.value).toBe("\u0024{a:b}");
    const m = t?.methods[0];
    expect(m).toMatchObject({
      name: "get",
      returnType: "ResponseEntity<Map<String,Long>>",
      throws: ["A", "B"],
      line: 15,
    });
    expect(m?.parameters).toEqual([
      {
        name: "id",
        type: "Long",
        annotations: [
          { name: "PathVariable", arguments: { value: { text: '"id"', value: "id" } }, line: 15 },
        ],
      },
      { name: "rest", type: "String...", annotations: [], varargs: true },
    ]);
    expect(f.references).toContain("RequestMethod");
    expect(f.references).toContain("Comparable");
    expect(f.error).toBeUndefined();
  });

  test("records, sealed interfaces, enums, annotation types and nested types (Java 21)", async () => {
    const f = await parse(`package p;
public sealed interface Shape permits Shape.Circle, Shape.Square {
  int SIDES = 4;
  double area();
  record Circle(@NotNull double radius) implements Shape { public Circle { } public double area() { return 1; } }
  record Square(double side) implements Shape { public double area() { return switch (this) { case Square(double s) when s > 0 -> s * s; default -> 0; }; } }
  enum Kind { ROUND("r") { void x() {} }, FLAT; Kind() {} Kind(String s) {} }
  @interface Marker { String value() default ""; }
}`);
    const shape = f.types[0];
    expect(shape).toMatchObject({
      kind: "interface",
      modifiers: ["public", "sealed"],
      permits: ["Shape.Circle", "Shape.Square"],
    });
    expect(shape?.fields.map((x) => x.name)).toEqual(["SIDES"]);
    expect(shape?.methods.map((x) => x.name)).toEqual(["area"]);
    const [circle, square, kind, marker] = shape?.nested ?? [];
    expect(circle).toMatchObject({ kind: "record", qualifiedName: "p.Shape.Circle", implements: ["Shape"] });
    expect(circle?.components.map((c) => c.name)).toEqual(["radius"]);
    // A compact canonical constructor takes the record's components.
    expect(circle?.constructors[0]?.parameters.map((p) => p.name)).toEqual(["radius"]);
    expect(square?.methods[0]?.name).toBe("area");
    expect(kind).toMatchObject({ kind: "enum", enumConstants: ["ROUND", "FLAT"] });
    expect(kind?.constructors).toHaveLength(2);
    expect(marker).toMatchObject({ kind: "annotation", qualifiedName: "p.Shape.Marker" });
    expect(marker?.methods[0]).toMatchObject({ name: "value", returnType: "String" });
    expect(allTypes(f.types).map((t) => t.name)).toEqual(["Shape", "Circle", "Square", "Kind", "Marker"]);
    expect(f.error).toBeUndefined();
  });

  test("a file with a syntax error keeps what it declares and says where it broke", async () => {
    const f = await parse(`package p;
public class Broken {
  public int half(int value) {
    return value / 2
  }
  public String fine() { return "x"; }
}`);
    expect(f.error).toMatchObject({ line: 4 });
    expect(f.error?.message).toContain("syntax error");
    expect(f.types[0]?.methods.map((m) => m.name)).toEqual(["half", "fine"]);
  });

  test("router calls are kept with the call that holds them and the method they are in", async () => {
    const f = await parse(`package p;
class Routes {
  RouterFunction<ServerResponse> r(Handler h) {
    return route().GET("/a", h::list).POST("/b", h::add).build();
  }
  RouterFunction<ServerResponse> s(Handler h) { return RouterFunctions.route(GET("/c"), h::c); }
}`);
    const names = f.calls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["route", "GET", "POST"]));
    const get = f.calls.find((c) => c.name === "GET" && c.arguments[0]?.value === "/a");
    expect(get).toMatchObject({ in: "p.Routes#r", line: 4 });
    expect(get?.arguments[1]?.text).toBe("h::list");
    const inner = f.calls.find((c) => c.arguments[0]?.value === "/c");
    expect(f.calls[inner?.within as number]?.name).toBe("route");
  });

  test("a call in a chain over several lines is on the line of its own name, not of the chain's start", async () => {
    const f = await parse(`package p;
class Routes {
  RouterFunction<ServerResponse> r(Handler h) {
    return route()
        .GET("/a", h::list)
        .POST("/b", h::add)
        .build();
  }
}`);
    const at = (name: string) => f.calls.find((c) => c.name === name)?.line;
    expect([at("route"), at("GET"), at("POST")]).toEqual([4, 5, 6]);
  });

  test("values: numbers, booleans, chars, escapes, text blocks; anything else is its text", async () => {
    const f = await parse(`class V {
  @A(n = 10, h = 0x1F, d = 1.5, b = true, c = 'x', s = "a\\tb", e = X.Y, t = """
      hello
        world
      """)
  int x;
}`);
    const args = f.types[0]?.fields[0]?.annotations[0]?.arguments ?? {};
    expect(args.n?.value).toBe(10);
    expect(args.h?.value).toBe(31);
    expect(args.d?.value).toBe(1.5);
    expect(args.b?.value).toBe(true);
    expect(args.c?.value).toBe("x");
    expect(args.s?.value).toBe("a\tb");
    expect(args.e).toEqual({ text: "X.Y" });
    expect(args.t?.value).toBe("hello\n  world\n");
  });

  test("a parser whose grammar is missing is an error value, never a throw", async () => {
    const broken = new TreeSitterJavaParser(() => ({
      runtime: "/nowhere/rt.wasm",
      language: "/nowhere/java.wasm",
    }));
    const r = await broken.parse("A.java", "class A {}");
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
  });

  test("helpers", () => {
    expect(normalizeType("Map < String ,  List< Long > >")).toBe("Map<String,List<Long>>");
    expect(normalizeType("java . util . List")).toBe("java.util.List");
    expect(textBlock("\n    a\n      b\n    ")).toBe("a\n  b\n");
  });
});
