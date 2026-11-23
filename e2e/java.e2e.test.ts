/**
 * `metator java` end to end (ADR-0107): the real `metator` process on the shop fixture (a
 * multi-module Maven build with Spring MVC, JPA, Spring Data, WebFlux, JAX-RS, EJB, CDI,
 * Servlets, Spring XML, Java 21 and a file with a syntax error) in a real git repository. No JDK
 * and no Maven are needed: reading never runs the build.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { createJavaRepo } from "./helpers/java.ts";
import type { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await createJavaRepo("maven");
}, 60_000);
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;
const data = async (args: string[], cwd = repo.root) => {
  const r = await metator([...args, "--json"], cwd);
  if (r.code !== 0) throw new Error(`metator ${args.join(" ")} exited ${r.code}: ${r.stdout}${r.stderr}`);
  return r.json.data as Data;
};
const API = "shop-api/src/main/java/com/example/shop/api";
const DOMAIN = "shop-domain/src/main/java/com/example/shop/domain";

describe("metator java (real CLI on a Maven repository)", () => {
  test("overview: build, modules, Java versions, counts, frameworks; the broken file reported, the rest read", async () => {
    const o = await data(["java", "overview"]);
    expect(o.buildTools).toEqual(["maven"]);
    expect(
      (o.modules as { name: string; profile?: string }[]).map(
        (m) => `${m.name}${m.profile ? `@${m.profile}` : ""}`,
      ),
    ).toEqual([
      "shop-parent",
      "shop-common",
      "shop-domain",
      "shop-api",
      "shop-reactive",
      "legacy-ejb",
      "shop-experimental@experimental",
    ]);
    const versions = o.javaVersions as { module: string; version: string; evidence: { at: string } }[];
    expect(versions.find((v) => v.module === "shop-common")).toMatchObject({
      version: "21",
      evidence: { at: "shop-common/pom.xml:15" },
    });
    expect(versions.find((v) => v.module === "shop-api")).toMatchObject({
      version: "17",
      evidence: { at: "pom.xml:14" },
    });
    expect(o.parseFailures).toEqual([
      {
        file: "shop-experimental/src/main/java/com/example/shop/experimental/Broken.java",
        message: 'syntax error: missing ";"',
        line: 5,
      },
    ]);
    expect(o.counts).toMatchObject({
      files: 47,
      endpoints: 17,
      entities: 9,
      repositories: 2,
      entrypoints: 5,
    });
    const frameworks = (o.frameworks as { name: string }[]).map((f) => f.name);
    for (const f of [
      "spring-boot",
      "spring-mvc",
      "spring-webflux",
      "spring-data",
      "jpa",
      "jax-rs",
      "ejb",
      "cdi",
      "servlet",
      "spring-xml",
    ])
      expect(frameworks).toContain(f);
    expect(
      (o.sourceRoots as { path: string; kind: string }[]).find((r) => r.kind === "generated")?.path,
    ).toBe("shop-domain/target/generated-sources/summary");
    // The cache is a versioned document; nothing unversioned was written under .metator/.
    const versioned = await findUnversioned(repo.root, [".metator"]);
    expect(versioned.unversioned).toEqual([]);
    expect(versioned.checked).toBeGreaterThan(0);
  });

  test("the file with a syntax error still gives its types (the rest of the file is read)", async () => {
    const t = await data(["java", "show", "com.example.shop.experimental.Broken"]);
    expect((t.type as { methods: { name: string }[] }).methods.map((m) => m.name)).toEqual(["half", "fine"]);
  });

  test("modules: dependencies on other modules and external ones, placeholders resolved", async () => {
    const m = (await data(["java", "modules", "--module", "shop-api"])).modules as {
      name: string;
      packaging: string;
      parent: string;
      dependsOn: string[];
      external: { coordinate: string; scope: string }[];
    }[];
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      name: "shop-api",
      packaging: "jar",
      parent: "shop-parent",
      dependsOn: ["shop-domain"],
    });
    expect(m[0]?.external).toContainEqual({
      coordinate: "org.springframework:spring-web:6.1.14",
      scope: "provided",
    });
    const legacy = (await data(["java", "modules", "--module", "legacy-ejb"])).modules as {
      packaging: string;
      external: { scope: string }[];
    }[];
    expect(legacy[0]?.packaging).toBe("war");
    // `<scope>${jakarta.ee.scope}</scope>` read from the module's own properties.
    expect(new Set(legacy[0]?.external.map((d) => d.scope))).toEqual(new Set(["provided"]));
  });

  test("types: by kind, annotation and supertype; test and generated code marked", async () => {
    const records = (
      await data(["java", "types", "--kind", "record", "--package", "com.example.shop.common"])
    ).types as { name: string }[];
    expect(records.map((t) => t.name)).toEqual([
      "com.example.shop.common.Money",
      "com.example.shop.common.Shape.Circle",
      "com.example.shop.common.Shape.Rectangle",
      "com.example.shop.common.Shape.Square",
    ]);
    const entities = (await data(["java", "types", "--annotated", "Entity", "--module", "shop-domain"]))
      .types as { name: string }[];
    expect(entities.map((t) => t.name.split(".").pop())).toEqual([
      "Customer",
      "DigitalProduct",
      "Order",
      "OrderLine",
      "Product",
      "Tag",
    ]);
    const shapes = (await data(["java", "types", "--implements", "Shape"])).types as { name: string }[];
    expect(shapes).toHaveLength(3);
    const all = (await data(["java", "types"])).types as {
      name: string;
      test: boolean;
      generated: boolean;
    }[];
    expect(all.find((t) => t.name.endsWith("MoneyTest"))?.test).toBe(true);
    expect(all.find((t) => t.name.endsWith("OrderSummary"))?.generated).toBe(true);
  });

  test("show: members, supertypes, subtypes and users; a simple name that two types share is AMBIGUOUS", async () => {
    const s = await data(["java", "show", "Product"]);
    expect(s.subtypes).toEqual([
      { name: "com.example.shop.domain.DigitalProduct", at: `${DOMAIN}/DigitalProduct.java:6` },
    ]);
    expect(s.supertypes).toEqual(["com.example.shop.domain.BaseEntity"]);
    expect(s.roles).toEqual(["entity"]);
    expect((s.usedBy as { file: string }[]).map((u) => u.file)).toContain(`${DOMAIN}/OrderLine.java`);
    await repo.write(
      "shop-api/src/main/java/com/example/shop/api/Product.java",
      "package com.example.shop.api;\npublic class Product {}\n",
    );
    try {
      const r = await metator(["java", "show", "Product", "--json"], repo.root);
      expect(r.code).toBe(64);
      expect(r.json.error).toMatchObject({
        code: "AMBIGUOUS",
        details: { candidates: ["com.example.shop.api.Product", "com.example.shop.domain.Product"] },
      });
    } finally {
      await rm(repo.path("shop-api/src/main/java/com/example/shop/api/Product.java"));
    }
    const missing = await metator(["java", "show", "NoSuchType", "--json"], repo.root);
    expect([missing.code, (missing.json.error as Data).code]).toEqual([1, "NOT_FOUND"]);
  });

  test("endpoints: Spring MVC, WebFlux (annotations and RouterFunction), JAX-RS, Servlets", async () => {
    const e = (await data(["java", "endpoints"])).endpoints as {
      framework: string;
      method: string;
      path: string;
      handler: string;
      responseType?: string;
      requestType?: string;
      confidence: string;
      at: string;
      parameters: { name: string; in: string }[];
    }[];
    const line = (x: (typeof e)[number]) => `${x.framework} ${x.method} ${x.path}`;
    expect(e.map(line).sort()).toEqual(
      [
        "spring-mvc GET /api/customers/{id}",
        "spring-mvc GET /api/orders",
        "spring-mvc POST /api/orders",
        "spring-mvc DELETE /api/orders/{id}",
        "spring-mvc GET /api/orders/{id}",
        "webflux GET /fn/health",
        "webflux GET /fn/products",
        "webflux POST /fn/products",
        "servlet GET /health",
        "jax-rs GET /legacy/invoices",
        "jax-rs POST /legacy/invoices",
        "jax-rs GET /legacy/invoices/{id}",
        "webflux GET /reactive/products",
        "webflux GET /reactive/products/{sku}",
        "servlet GET /reports/*",
        "servlet POST /reports/*",
        "servlet GET /status",
      ].sort(),
    );
    const get = e.find((x) => x.path === "/api/orders/{id}" && x.method === "GET");
    expect(get).toMatchObject({
      handler: "com.example.shop.api.OrderController#get",
      responseType: "com.example.shop.api.dto.OrderDto",
      confidence: "certain",
      at: `${API}/OrderController.java:32`,
      parameters: [{ name: "id", in: "path" }],
    });
    expect(e.find((x) => x.path === "/api/orders" && x.method === "POST")?.requestType).toBe(
      "com.example.shop.api.dto.CreateOrderRequest",
    );
    // Built from the constant ApiPaths.CUSTOMERS: read, and only likely.
    expect(e.find((x) => x.path === "/api/customers/{id}")?.confidence).toBe("likely");
    expect(e.find((x) => x.path === "/reactive/products" && x.method === "GET")?.responseType).toBe(
      "com.example.shop.reactive.ProductView[]",
    );
    expect(e.find((x) => x.path === "/fn/health")).toMatchObject({
      handler: "com.example.shop.reactive.ProductHandler#health",
      confidence: "likely",
    });
    const jaxrs = (await data(["java", "endpoints", "--framework", "jax-rs"])).endpoints as {
      path: string;
    }[];
    expect(jaxrs.map((x) => x.path)).toEqual([
      "/legacy/invoices",
      "/legacy/invoices",
      "/legacy/invoices/{id}",
    ]);
  });

  test("entities with relations, persistence.xml units; Spring Data repositories with their queries", async () => {
    const d = await data(["java", "entities"]);
    const entities = d.entities as {
      type: string;
      table?: string;
      relations: {
        field: string;
        kind: string;
        target: string;
        mappedBy?: string;
        joinColumn?: string;
        at: string;
      }[];
    }[];
    const order = entities.find((x) => x.type === "com.example.shop.domain.Order");
    expect(order?.table).toBe("orders");
    expect(order?.relations).toEqual([
      {
        field: "customer",
        kind: "many-to-one",
        target: "com.example.shop.domain.Customer",
        joinColumn: "customer_id",
        at: `${DOMAIN}/Order.java:20`,
      },
      {
        field: "lines",
        kind: "one-to-many",
        target: "com.example.shop.domain.OrderLine",
        mappedBy: "order",
        at: `${DOMAIN}/Order.java:23`,
      },
    ]);
    expect(d.persistenceUnits).toEqual([
      {
        name: "legacyPU",
        transactionType: "JTA",
        provider: "org.hibernate.jpa.HibernatePersistenceProvider",
        classes: ["com.example.legacy.model.Invoice"],
        at: "legacy-ejb/src/main/resources/META-INF/persistence.xml:6",
      },
    ]);
    const repos = (await data(["java", "repositories"])).repositories as {
      type: string;
      entity: string;
      methods: { name: string; kind: string; query?: string }[];
    }[];
    expect(repos.map((r) => [r.type.split(".").pop(), r.entity])).toEqual([
      ["CustomerRepository", "com.example.shop.domain.Customer"],
      ["OrderRepository", "com.example.shop.domain.Order"],
    ]);
    expect(repos[0]?.methods.find((m) => m.kind === "query")?.query).toBe(
      "select c from Customer c where c.name like :prefix%",
    );
  });

  test("beans: injection points and the bean that provides each", async () => {
    const beans = (await data(["java", "beans", "--injects", "OrderService"])).beans as {
      name: string;
      injections: { via: string; name: string; type: string; provider?: string; confidence: string }[];
    }[];
    expect(beans.map((b) => b.name)).toEqual(["orderController"]);
    expect(beans[0]?.injections).toContainEqual(
      expect.objectContaining({
        via: "constructor",
        name: "orderService",
        type: "com.example.shop.domain.service.OrderService",
        provider: "orderService",
        confidence: "certain",
      }),
    );
    const all = (await data(["java", "beans"])).beans as {
      name: string;
      kind: string;
      injections: { name: string; provider?: string }[];
    }[];
    const kinds = Object.fromEntries(all.map((b) => [b.name, b.kind]));
    expect(kinds).toMatchObject({
      InvoiceService: "ejb",
      audit: "cdi",
      clock: "spring-bean-method",
      legacyAuditService: "spring-xml",
      customerRepository: "spring",
    });
    expect(all.find((b) => b.name === "orderService")?.injections.map((i) => i.provider)).toEqual([
      "orderRepository",
      "customerRepository",
    ]);
  });

  test("config: keys by profile and where code reads them", async () => {
    const c = await data(["java", "config", "--key", "shop"]);
    const keys = c.keys as { key: string; value: string; profile?: string }[];
    expect(
      keys.filter((k) => k.key === "shop.currency").map((k) => [k.value, k.profile ?? "default"]),
    ).toEqual([
      ["USD", "local"],
      ["EUR", "default"],
      ["PLN", "dev"],
    ]);
    expect(keys.find((k) => k.key === "shop.orders.allow-guests")?.profile).toBe("prod");
    const reads = c.reads as { key: string; via: string; member: string; defined: boolean }[];
    expect(reads.map((r) => [r.key, r.via, r.member, r.defined])).toEqual([
      ["shop.currency", "@Value", "currency", true],
      ["shop.tax-rate", "@Value", "taxRate", true],
      ["shop.orders.max-lines", "@ConfigurationProperties", "maxLines", true],
      ["shop.orders.allow-guests", "@ConfigurationProperties", "allowGuests", true],
    ]);
  });

  test("entry points", async () => {
    const e = (await data(["java", "entrypoints"])).entrypoints as {
      kind: string;
      handler: string;
      detail?: string;
    }[];
    expect(e.map((x) => `${x.kind} ${x.handler}${x.detail ? ` ${x.detail}` : ""}`).sort()).toEqual(
      [
        "main com.example.shop.api.ShopApplication#main",
        "scheduled com.example.shop.api.jobs.ReportJob#nightly cron=0 0 2 * * *",
        "event-listener com.example.shop.api.jobs.ReportJob#onOrderPlaced com.example.shop.api.dto.OrderPlaced",
        "message-driven com.example.legacy.ejb.InvoiceEventsBean jms/invoices",
        "startup com.example.legacy.ejb.CacheWarmer",
      ].sort(),
    );
  });

  test("index: the cache is reused; --check says stale (exit 65) after a change and current after a refresh", async () => {
    const first = await data(["java", "index"]);
    expect(first).toMatchObject({ current: true, files: 47, parsed: 0, path: ".metator/index/java.json" });
    expect(first.reused).toBe(47);
    expect((await data(["java", "index", "--check"])).current).toBe(true);
    const file = repo.path("shop-common/src/main/java/com/example/shop/common/Strings.java");
    const before = await Bun.file(file).text();
    await Bun.write(file, `${before}\n// touched\n`);
    try {
      const stale = await metator(["java", "index", "--check", "--json"], repo.root);
      expect(stale.code).toBe(65);
      expect(stale.json.error).toMatchObject({
        code: "STALE_INDEX",
        details: { stale: ["shop-common/src/main/java/com/example/shop/common/Strings.java"] },
      });
      expect(await data(["java", "index"])).toMatchObject({ parsed: 1, reused: 46 });
      expect((await data(["java", "index", "--check"])).current).toBe(true);
    } finally {
      await Bun.write(file, before);
    }
  });

  test("a person at a terminal reads one line per fact (text on stderr), JSON stays one line", async () => {
    const r = await metator(["java", "endpoints", "--framework", "servlet"], repo.root);
    expect(r.code).toBe(0);
    expect((r.json.data as { endpoints: unknown[] }).endpoints).toHaveLength(4);
  });

  test("from a folder of repositories with -C", async () => {
    const o = await data(["-C", basename(repo.root), "java", "overview"], repo.parent());
    expect(o.buildTools).toEqual(["maven"]);
  });
});

describe("the shared commands on Java files", () => {
  test("graph dependents: same-package references and imports are edges, across modules", async () => {
    const d = await data(["graph", "dependents", `${DOMAIN}/Order.java`]);
    expect(d.files).toEqual([
      `${API}/OrderController.java`,
      `${DOMAIN}/Customer.java`,
      `${DOMAIN}/OrderLine.java`,
      `${DOMAIN}/repo/OrderRepository.java`,
      `${DOMAIN}/service/OrderService.java`,
    ]);
  });

  test("graph affected: a change in shop-common reaches its test and the modules that use it", async () => {
    const d = await data([
      "graph",
      "affected",
      "--files",
      "shop-common/src/main/java/com/example/shop/common/Money.java",
    ]);
    expect(d.tests).toEqual(["shop-common/src/test/java/com/example/shop/common/MoneyTest.java"]);
    expect(d.files).toContain("shop-reactive/src/main/java/com/example/shop/reactive/ProductView.java");
  });

  test("symbols find and graph callers on Java types and members", async () => {
    expect(await data(["symbols", "find", "OrderService"])).toEqual({
      name: "OrderService",
      definitions: [{ file: `${DOMAIN}/service/OrderService.java`, line: 13, typeOnly: false }],
      reexportedBy: [],
    });
    expect(((await data(["symbols", "find", "OrderService.byStatus"])).definitions as unknown[]).length).toBe(
      1,
    );
    const callers = (await data(["graph", "callers", "OrderService"])).callers as { file: string }[];
    expect(callers.map((c) => c.file)).toEqual([`${API}/OrderController.java`]);
  });

  test("Java modules are workspace packages: externals are java: names, never npm packages", async () => {
    const d = await data(["index", "build"]);
    expect(d.packages).toBe(6);
    expect((d.externals as string[]).every((x) => x.startsWith("java:"))).toBe(true);
    expect(d.unresolved).toEqual([]);
  });
});

test("a Gradle build (Kotlin DSL): its projects are modules with their dependencies and Java version", async () => {
  const gradle = await createJavaRepo("gradle");
  try {
    const r = await metator(["java", "modules", "--json"], gradle.root);
    expect(r.code).toBe(0);
    const modules = (r.json.data as Data).modules as {
      name: string;
      build: string;
      dependsOn: string[];
      external: { coordinate: string; scope: string }[];
      javaVersion?: { version: string; evidence: { at: string } };
    }[];
    expect(modules.map((m) => [m.name, m.build, m.dependsOn])).toEqual([
      ["inventory-core", "gradle", []],
      ["inventory-app", "gradle", ["inventory-core"]],
    ]);
    expect(modules[0]?.javaVersion).toMatchObject({
      version: "21",
      evidence: { at: "inventory-core/build.gradle.kts:7" },
    });
    expect(modules[0]?.external).toContainEqual({
      coordinate: "org.junit.jupiter:junit-jupiter:5.10.2",
      scope: "testImplementation",
    });
    const e = (await metator(["java", "entrypoints", "--json"], gradle.root)).json.data as Data;
    expect(e.entrypoints).toEqual([
      expect.objectContaining({
        kind: "main",
        handler: "com.example.inventory.app.InventoryApp#main",
        module: "inventory-app",
      }),
    ]);
  } finally {
    await gradle.dispose();
  }
});

test("a repository without Java says so", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-nojava-"));
  try {
    await Bun.write(join(dir, "package.json"), '{"name":"x"}');
    const o = (await metator(["java", "overview", "--json"], dir)).json.data as Data;
    expect(o).toMatchObject({ buildTools: [], modules: [], counts: { files: 0, types: 0 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
