import { describe, expect, test } from "bun:test";
import type { JavaField } from "../src/index.ts";
import { javaBeans, javaEntities, javaRepositories, persistenceUnits } from "../src/index.ts";
import { ann, file, method, param, repo, type } from "./fixtures/java.ts";

const field = (name: string, t: string, ...annotations: ReturnType<typeof ann>[]): JavaField => ({
  name,
  type: t,
  modifiers: ["private"],
  annotations,
  line: 1,
});

describe("JPA entities", () => {
  const base = type("d.BaseEntity", {
    annotations: [ann("MappedSuperclass")],
    fields: [field("id", "Long", ann("Id"), ann("GeneratedValue", { strategy: "=GenerationType.IDENTITY" }))],
  });
  const order = type("d.Order", {
    extends: ["BaseEntity"],
    annotations: [ann("Entity"), ann("Table", { name: "orders" })],
    fields: [
      field("customer", "Customer", ann("ManyToOne"), ann("JoinColumn", { name: "customer_id" })),
      field("lines", "List<OrderLine>", ann("OneToMany", { mappedBy: "order" })),
      field("status", "OrderStatus", ann("Enumerated", "=EnumType.STRING")),
      field(
        "note",
        "String",
        ann("Column", { name: "note_text", nullable: false, length: 200, unique: true }),
      ),
      field("cache", "String", ann("Transient")),
      { ...field("COUNT", "int"), modifiers: ["static"] },
    ],
  });
  const customer = type("d.Customer", {
    annotations: [ann("Entity", { name: "Client" }), ann("Inheritance")],
    fields: [
      field("orders", "Set<Order>", ann("OneToMany", { mappedBy: "customer", targetEntity: "=Order.class" })),
      field("address", "Address"),
    ],
  });
  const address = type("d.Address", { annotations: [ann("Embeddable")], fields: [field("city", "String")] });
  const line = type("d.OrderLine", {
    annotations: [ann("Entity")],
    fields: [field("order", "Order", ann("ManyToOne"))],
  });
  const plain = type("d.NotAnEntity", { fields: [field("x", "String", ann("Column"))] });
  const r = repo([base, order, customer, address, line, plain].map((t) => file("domain", [t])));

  test("kinds, table and entity names, ids, columns, relations with their targets, inheritance", () => {
    const e = Object.fromEntries(javaEntities(r).map((x) => [x.type, x]));
    expect(Object.keys(e).sort()).toEqual([
      "d.Address",
      "d.BaseEntity",
      "d.Customer",
      "d.Order",
      "d.OrderLine",
    ]);
    expect(e["d.BaseEntity"]).toMatchObject({
      kind: "mapped-superclass",
      id: [{ field: "id", type: "Long", generated: "IDENTITY" }],
    });
    expect(e["d.Order"]).toMatchObject({ kind: "entity", table: "orders", extends: "d.BaseEntity" });
    expect(
      e["d.Order"]?.relations.map((x) => [x.field, x.kind, x.target, x.mappedBy ?? "", x.joinColumn ?? ""]),
    ).toEqual([
      ["customer", "many-to-one", "d.Customer", "", "customer_id"],
      ["lines", "one-to-many", "d.OrderLine", "order", ""],
    ]);
    expect(
      e["d.Order"]?.columns.map((c) => [
        c.field,
        c.column,
        c.nullable,
        c.length,
        c.unique,
        c.enumerated,
        c.transient,
      ]),
    ).toEqual([
      ["status", undefined, undefined, undefined, undefined, "STRING", undefined],
      ["note", "note_text", false, 200, true, undefined, undefined],
      ["cache", undefined, undefined, undefined, undefined, undefined, true],
    ]);
    expect(e["d.Customer"]).toMatchObject({ name: "Client", inheritance: "SINGLE_TABLE" });
    expect(e["d.Customer"]?.relations[0]?.target).toBe("d.Order");
    expect(e["d.Customer"]?.columns.find((c) => c.field === "address")?.embedded).toBe(true);
    expect(e["d.Address"]?.kind).toBe("embeddable");
  });

  test("property access: mappings on getters", () => {
    const t = type("d.P", {
      annotations: [ann("Entity")],
      methods: [
        method("getId", { returnType: "Long", annotations: [ann("Id")] }),
        method("getOwner", { returnType: "Customer", annotations: [ann("ManyToOne")] }),
      ],
    });
    const e = javaEntities(repo([file("d", [t]), file("d", [type("d.Customer")])]))[0];
    expect(e?.id.map((i) => i.field)).toEqual(["id"]);
    expect(e?.relations.map((x) => [x.field, x.target])).toEqual([["owner", "d.Customer"]]);
  });

  test("persistence units come from persistence.xml with their place", () => {
    const pr = repo([], {
      descriptors: [
        {
          path: "l/META-INF/persistence.xml",
          facts: { persistenceUnits: [{ name: "pu", classes: ["a.B"], line: 3 }] },
        },
      ],
    });
    expect(persistenceUnits(pr)).toEqual([
      { name: "pu", classes: ["a.B"], at: "l/META-INF/persistence.xml:3" },
    ]);
  });
});

describe("Spring Data repositories", () => {
  test("entity and id from the base's type arguments; derived, @Query and other methods", () => {
    const customer = type("d.Customer", { annotations: [ann("Entity")] });
    const repoType = type("d.CustomerRepository", {
      kind: "interface",
      extends: ["JpaRepository<Customer, Long>"],
      methods: [
        method("findByEmail", { returnType: "Optional<Customer>" }),
        method("countByStatusAndCity", { returnType: "long" }),
        method("search", {
          annotations: [ann("Query", { value: "select c from Customer c", nativeQuery: true })],
        }),
        method("custom"),
      ],
    });
    const r = javaRepositories(
      repo([
        file("d", [customer]),
        file("d", [repoType], {
          imports: [
            {
              name: "org.springframework.data.jpa.repository.JpaRepository",
              static: false,
              onDemand: false,
              line: 1,
            },
          ],
        }),
      ]),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      type: "d.CustomerRepository",
      base: "JpaRepository",
      entity: "d.Customer",
      id: "Long",
    });
    expect(r[0]?.methods.map((m) => [m.name, m.kind, m.query ?? "", m.native ?? false])).toEqual([
      ["findByEmail", "derived", "", false],
      ["countByStatusAndCity", "derived", "", false],
      ["search", "query", "select c from Customer c", true],
      ["custom", "other", "", false],
    ]);
  });

  test("through a generic base interface of the repository; @NoRepositoryBean and classes are not repositories", () => {
    const base = type("d.BaseRepo", {
      kind: "interface",
      typeParameters: ["T"],
      annotations: [ann("NoRepositoryBean")],
      extends: ["CrudRepository<T, Long>"],
    });
    const orders = type("d.OrderRepo", { kind: "interface", extends: ["BaseRepo<Order>"] });
    const order = type("d.Order");
    const notRepo = type("d.Impl", { extends: ["CrudRepository<Order, Long>"] });
    const r = javaRepositories(repo([base, orders, order, notRepo].map((t) => file("d", [t]))));
    expect(r.map((x) => [x.type, x.base, x.entity, x.id])).toEqual([
      ["d.OrderRepo", "CrudRepository", "d.Order", "Long"],
    ]);
  });
});

describe("beans and their wiring", () => {
  const service = type("s.OrderService", {
    annotations: [ann("Service")],
    constructors: [
      {
        parameters: [
          param("orders", "OrderRepository"),
          param("rate", "String", ann("Value", "\u0024{rate}")),
        ],
        throws: [],
        modifiers: ["public"],
        annotations: [],
        line: 4,
      },
    ],
  });
  const repoType = type("s.OrderRepository", { kind: "interface", extends: ["JpaRepository<Order, Long>"] });
  const order = type("s.Order", { annotations: [ann("Entity")] });
  const api = type("s.Api", { kind: "interface" });
  const a = type("s.ApiA", { annotations: [ann("Component", "first")], implements: ["Api"] });
  const b = type("s.ApiB", { annotations: [ann("Component"), ann("Primary")], implements: ["Api"] });
  const consumer = type("s.Consumer", {
    annotations: [ann("RestController")],
    fields: [
      field("any", "Api", ann("Autowired")),
      field("named", "Api", ann("Autowired"), ann("Qualifier", "first")),
      field("all", "List<Api>", ann("Autowired")),
      field("missing", "Nothing", ann("Inject")),
      field("plain", "OrderService"),
    ],
    methods: [
      method("setService", { parameters: [param("s", "OrderService")], annotations: [ann("Autowired")] }),
    ],
  });
  const config = type("s.Config", {
    annotations: [ann("Configuration")],
    methods: [
      method("clock", {
        returnType: "java.time.Clock",
        annotations: [ann("Bean")],
        parameters: [param("api", "Api")],
      }),
    ],
  });
  const lombok = type("s.Lombok", {
    annotations: [ann("Service"), ann("RequiredArgsConstructor")],
    fields: [
      { ...field("service", "OrderService"), modifiers: ["private", "final"] },
      field("notInjected", "OrderService"),
    ],
  });
  const ejb = type("e.Bean", {
    annotations: [ann("Stateless")],
    fields: [field("svc", "OrderService", ann("EJB"))],
  });
  const cdi = type("e.Cdi", { annotations: [ann("ApplicationScoped"), ann("Named", "audit")] });
  const injectSingleton = type("e.S", { annotations: [ann("Singleton")] });
  const inTest = type("s.InTest", { annotations: [ann("Component")] });
  const r = repo(
    [
      ...[service, repoType, order, api, a, b, consumer, config, lombok].map((t) => file("app", [t])),
      file("app", [ejb], { imports: [{ name: "s.OrderService", static: false, onDemand: false, line: 1 }] }),
      file("app", [cdi]),
      file("app", [injectSingleton], {
        imports: [{ name: "jakarta.inject.Singleton", static: false, onDemand: false, line: 1 }],
      }),
      file("app", [inTest], { test: true }),
    ],
    {
      descriptors: [
        {
          path: "app/src/main/resources/ctx.xml",
          module: "app",
          facts: {
            beans: [
              {
                id: "x",
                className: "s.ApiA",
                line: 2,
                properties: [{ name: "service", ref: "orderService", line: 3 }],
                constructorArgs: [],
              },
            ],
          },
        },
      ],
    },
  );
  const beans = javaBeans(r);
  const bean = (name: string) => beans.find((x) => x.name === name);

  test("stereotypes, names, kinds; Spring Data repositories and @Bean methods are beans; test code is not", () => {
    expect(beans.map((x) => `${x.kind}:${x.name}:${x.stereotype}`).sort()).toEqual(
      [
        "spring:orderService:Service",
        "spring:first:Component",
        "spring:apiB:Component",
        "spring:consumer:RestController",
        "spring:config:Configuration",
        "spring-bean-method:clock:Bean",
        "spring:lombok:Service",
        "ejb:Bean:Stateless",
        "cdi:audit:ApplicationScoped",
        "cdi:s:Singleton",
        "spring:orderRepository:SpringDataRepository",
        "spring-xml:x:bean",
      ].sort(),
    );
    expect(bean("clock")?.type).toBe("java.time.Clock");
    expect(bean("audit")?.scope).toBe("ApplicationScoped");
  });

  test("constructor injection of the only constructor; @Value parameters are configuration, not beans", () => {
    expect(bean("orderService")?.injections).toEqual([
      expect.objectContaining({
        via: "constructor",
        name: "orders",
        type: "s.OrderRepository",
        provider: "orderRepository",
        candidates: 1,
        confidence: "certain",
      }),
    ]);
  });

  test("one provider is certain; a qualifier picks by name; @Primary is likely; none or many has no provider", () => {
    const i = Object.fromEntries((bean("consumer")?.injections ?? []).map((x) => [x.name, x]));
    expect(i.any).toMatchObject({
      via: "field",
      annotation: "Autowired",
      provider: "apiB",
      candidates: 3,
      confidence: "likely",
    });
    expect(i.named).toMatchObject({ qualifier: "first", provider: "first", confidence: "certain" });
    expect(i.all).toMatchObject({ type: "s.Api", confidence: "likely" });
    expect(i.missing).toMatchObject({ candidates: 0, confidence: "likely" });
    expect(i.missing).not.toHaveProperty("provider");
    expect(i.plain).toBeUndefined(); // not annotated: not injected
    expect(i.service).toMatchObject({ via: "setter", provider: "orderService" });
  });

  test("@Bean method parameters, Lombok constructors, EJB @EJB fields and XML references are injection points", () => {
    expect(bean("clock")?.injections[0]).toMatchObject({ via: "method-parameter", type: "s.Api" });
    expect(bean("lombok")?.injections.map((x) => x.name)).toEqual(["service"]);
    expect(bean("Bean")?.injections[0]).toMatchObject({ annotation: "EJB", provider: "orderService" });
    expect(bean("x")?.injections[0]).toMatchObject({
      via: "xml-property",
      qualifier: "orderService",
      provider: "orderService",
      confidence: "certain",
    });
  });
});
