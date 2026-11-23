import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTypeIndex, declaredTypes, JavaImportAnalyzer, packageOf } from "../src/java-import-analyzer.ts";
import { lexJava, tokenize } from "../src/java-lexer.ts";

let root: string;
const files: Record<string, string> = {
  "app/src/main/java/com/shop/api/OrderController.java": `package com.shop.api;

import com.shop.domain.Order;
import com.shop.domain.Order.Line;
import com.shop.util.*;
import static com.shop.domain.Limits.MAX;
import java.util.List;
import org.springframework.web.bind.annotation.*;

// Helper and "Customer" in a comment or a string are not references.
public class OrderController {
  private final Pricing pricing = new Pricing(); // same package, no import
  List<Order> list() { return Strings.none(); } // Strings from com.shop.util.*
  String s = "Customer";
}
`,
  "app/src/main/java/com/shop/api/Pricing.java": "package com.shop.api;\npublic class Pricing {}\n",
  "domain/src/main/java/com/shop/domain/Order.java": `package com.shop.domain;
public class Order {
  public static class Line {}
  private Customer customer;
}
`,
  "domain/src/main/java/com/shop/domain/Customer.java":
    "package com.shop.domain;\npublic class Customer { Order last; }\n",
  "domain/src/main/java/com/shop/domain/Limits.java":
    "package com.shop.domain;\npublic final class Limits { public static final int MAX = 3; }\n",
  "domain/src/main/java/com/shop/util/Strings.java":
    "package com.shop.util;\npublic final class Strings {}\nfinal class Hidden {}\n",
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "metator-java-imports-"));
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the Java lexer", () => {
  test("comments, strings, text blocks and chars are not tokens; lines are counted through them", () => {
    const t = tokenize('/* a\n b */ x // y\n"s\\"q" \'c\' """\n t\n""" z');
    expect(t.map((x) => x.text)).toEqual(["x", '""', "''", '""', "z"]);
    expect(t.find((x) => x.text === "z")?.line).toBe(5);
  });

  test("top-level types with their public members; interface members are public; enum constants", () => {
    const lex = lexJava(`package a.b;
import x.Y;
@Ann({"a", "b"})
public class C extends Base {
  public static final String NAME = "n";
  private int hidden;
  public int a, b;
  @Override public String toString() { return "{"; }
  void packagePrivate() {}
  public C() {}
  public static class Inner { public void deep() {} }
  int[] arr = {1, 2};
  public Runnable r = () -> { int z; };
}
interface I { void run(); private void no() {} }
enum E { ONE, @Deprecated TWO(2) { }, THREE; public void m() {} }
record R(int x) { public int twice() { return x * 2; } }
@interface Marker {}
`);
    expect(lex.package).toBe("a.b");
    expect(lex.imports).toEqual([{ name: "x.Y", static: false, onDemand: false, line: 2 }]);
    const byName = Object.fromEntries(
      lex.types.map((t) => [t.name, t.members.filter((m) => m.public).map((m) => m.name)]),
    );
    expect(byName).toEqual({
      C: ["NAME", "a", "b", "toString", "r"],
      I: ["run"],
      E: ["ONE", "TWO", "THREE", "m"],
      R: ["twice"],
      Marker: [],
    });
    expect(lex.types.map((t) => t.kind)).toEqual(["class", "interface", "enum", "record", "annotation"]);
    expect([...lex.declared]).toContain("Inner");
    expect(lex.references.has("Base")).toBe(true);
    expect(lex.references.has("Y")).toBe(false); // in the import, not a use
  });

  test("a file with a syntax error still has its imports and types", () => {
    const lex = lexJava("package p;\nimport q.R;\nclass Broken { int x( }\nclass After {}\n");
    expect(lex.imports.map((i) => i.name)).toEqual(["q.R"]);
    expect(lex.types.map((t) => t.name)).toContain("Broken");
  });
});

describe("JavaImportAnalyzer", () => {
  test("the type index: package and top-level types of every .java file, by pattern", () => {
    expect(
      declaredTypes("x/Strings.java", files["domain/src/main/java/com/shop/util/Strings.java"] as string),
    ).toEqual({
      package: "com.shop.util",
      types: ["Strings", "Hidden"],
    });
    const index = buildTypeIndex(root);
    expect(index.files.get("com.shop.domain.Order")).toBe("domain/src/main/java/com/shop/domain/Order.java");
    expect(index.packages.has("com.shop.util")).toBe(true);
    expect(packageOf("org.springframework.http.ResponseEntity")).toBe("org.springframework.http");
    expect(packageOf("a.b.c")).toBe("a.b");
  });

  test("imports resolve to files; same-package and on-demand references are edges; the rest is external", () => {
    const a = new JavaImportAnalyzer(root);
    const from = "app/src/main/java/com/shop/api/OrderController.java";
    const specs = a
      .parse(from, files[from] as string)
      ._unsafeUnwrap()
      .map((s) => s.specifier);
    expect(specs).toEqual([
      "com.shop.domain.Order",
      "com.shop.domain.Order.Line",
      "com.shop.domain.Limits",
      "java.util.List",
      "org.springframework.web.bind.annotation.*",
      "com.shop.api.Pricing",
      "com.shop.util.Strings",
    ]);
    const resolved = specs.map((s) => a.resolve(from, s));
    expect(resolved).toEqual([
      { type: "file", path: "domain/src/main/java/com/shop/domain/Order.java" },
      { type: "file", path: "domain/src/main/java/com/shop/domain/Order.java" },
      { type: "file", path: "domain/src/main/java/com/shop/domain/Limits.java" },
      { type: "external", name: "java:java.util" },
      { type: "external", name: "java:org.springframework.web.bind.annotation" },
      { type: "file", path: "app/src/main/java/com/shop/api/Pricing.java" },
      { type: "file", path: "domain/src/main/java/com/shop/util/Strings.java" },
    ]);
    // A type of the repository's own package that no file declares is a missing file, not a library.
    expect(a.resolve(from, "com.shop.domain.Gone")).toEqual({ type: "unresolved" });
  });

  test("same-package references go both ways (Order ↔ Customer), never to the file itself", () => {
    const a = new JavaImportAnalyzer(root);
    const order = "domain/src/main/java/com/shop/domain/Order.java";
    expect(
      a
        .parse(order, files[order] as string)
        ._unsafeUnwrap()
        .map((s) => s.specifier),
    ).toEqual(["com.shop.domain.Customer"]);
    const customer = "domain/src/main/java/com/shop/domain/Customer.java";
    expect(
      a
        .parse(customer, files[customer] as string)
        ._unsafeUnwrap()
        .map((s) => s.specifier),
    ).toEqual(["com.shop.domain.Order"]);
  });

  test("the fingerprint changes with the content and with the repository's set of types", () => {
    let digest = "one";
    const a = new JavaImportAnalyzer(root, (r) => ({ ...buildTypeIndex(r), digest }));
    const before = a.fingerprint("class A {}");
    expect(a.fingerprint("class B {}")).not.toBe(before);
    digest = "two";
    expect(
      new JavaImportAnalyzer(root, (r) => ({ ...buildTypeIndex(r), digest })).fingerprint("class A {}"),
    ).not.toBe(before);
  });

  test("symbols: top-level types and public members exported; imports and same-package uses named", () => {
    const a = new JavaImportAnalyzer(root);
    const from = "app/src/main/java/com/shop/api/OrderController.java";
    const s = a.symbols(from, files[from] as string)._unsafeUnwrap();
    expect(s.exports.map((e) => e.name)).toEqual(["OrderController"]);
    expect(s.imports).toContainEqual({
      specifier: "com.shop.domain.Order",
      imported: "Order",
      local: "Order",
      line: 3,
      typeOnly: false,
    });
    expect(s.imports).toContainEqual({
      specifier: "com.shop.domain.Limits",
      imported: "MAX",
      local: "MAX",
      line: 6,
      typeOnly: false,
    });
    expect(s.imports).toContainEqual(
      expect.objectContaining({ specifier: "com.shop.api.Pricing", imported: "Pricing" }),
    );
    expect(s.imports.some((i) => i.specifier.endsWith(".*"))).toBe(false);
    const limits = "domain/src/main/java/com/shop/domain/Limits.java";
    expect(
      a
        .symbols(limits, files[limits] as string)
        ._unsafeUnwrap()
        .exports.map((e) => e.name),
    ).toEqual(["Limits", "Limits.MAX"]);
  });
});
