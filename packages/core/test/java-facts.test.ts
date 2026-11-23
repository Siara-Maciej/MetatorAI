import { describe, expect, test } from "bun:test";
import {
  canonicalKey,
  configKeys,
  configReads,
  javaEntrypoints,
  javaFrameworks,
  kebab,
  moduleOfPath,
  placeholders,
  resolvePlaceholders,
} from "../src/index.ts";
import { ann, file, method, module, param, repo, type } from "./fixtures/java.ts";

describe("configuration", () => {
  const pricing = type("p.Pricing", {
    fields: [
      {
        name: "currency",
        type: "String",
        modifiers: [],
        annotations: [ann("Value", "\u0024{shop.currency:EUR}")],
        line: 5,
      },
      {
        name: "rate",
        type: "String",
        modifiers: [],
        annotations: [ann("Value", "\u0024{shop.tax_rate}/\u0024{shop.missing}")],
        line: 6,
      },
      { name: "spel", type: "String", modifiers: [], annotations: [ann("Value", "#{1 + 1}")], line: 7 },
    ],
  });
  const props = type("p.ShopProps", {
    annotations: [ann("ConfigurationProperties", { prefix: "shop.orders" })],
    fields: [
      { name: "maxLines", type: "int", modifiers: ["private"], annotations: [], line: 3 },
      { name: "DEFAULT", type: "int", modifiers: ["static"], annotations: [], line: 4 },
    ],
  });
  const record = type("p.Mail", { kind: "record", line: 9, components: [param("host", "String")] });
  const config = type("p.Config", {
    methods: [
      method("mail", {
        returnType: "Mail",
        annotations: [ann("Bean"), ann("ConfigurationProperties", "mail")],
      }),
    ],
  });
  const r = repo(
    [pricing, props, record, config].map((t) => file("api", [t])),
    {
      descriptors: [
        {
          path: "api/src/main/resources/application.yml",
          facts: {
            config: [
              { key: "shop.currency", value: "EUR", line: 2 },
              { key: "shop.tax-rate", value: "0.2", line: 3 },
              { key: "shop.orders.max-lines", value: "9", profile: "prod", line: 9 },
            ],
          },
        },
      ],
    },
  );

  test("keys with their profile and place", () => {
    expect(configKeys(r)).toEqual([
      { key: "shop.currency", value: "EUR", at: "api/src/main/resources/application.yml:2" },
      { key: "shop.tax-rate", value: "0.2", at: "api/src/main/resources/application.yml:3" },
      {
        key: "shop.orders.max-lines",
        value: "9",
        profile: "prod",
        at: "api/src/main/resources/application.yml:9",
      },
    ]);
  });

  test("@Value placeholders (with defaults; relaxed binding for 'defined'); SpEL is not a key", () => {
    const reads = configReads(r).filter((x) => x.via === "@Value");
    expect(reads.map((x) => [x.key, x.member, x.default ?? "", x.defined, x.at])).toEqual([
      ["shop.currency", "currency", "EUR", true, "api/src/main/java/p/Pricing.java:5"],
      ["shop.tax_rate", "rate", "", true, "api/src/main/java/p/Pricing.java:6"],
      ["shop.missing", "rate", "", false, "api/src/main/java/p/Pricing.java:6"],
    ]);
  });

  test("@ConfigurationProperties classes and @Bean methods: prefix + each field in kebab case", () => {
    const reads = configReads(r).filter((x) => x.via === "@ConfigurationProperties");
    expect(reads.map((x) => [x.key, x.type, x.member, x.defined])).toEqual([
      ["shop.orders.max-lines", "p.ShopProps", "maxLines", true],
      ["mail.host", "p.Mail", "host", false],
    ]);
  });

  test("helpers", () => {
    expect(placeholders("\u0024{a}-\u0024{b:x}")).toEqual([{ key: "a" }, { key: "b", default: "x" }]);
    expect(kebab("maxLinesPerOrder")).toBe("max-lines-per-order");
    expect(canonicalKey("shop.MAX_lines")).toBe(canonicalKey("shop.max-lines"));
    expect(
      resolvePlaceholders(
        "\u0024{a}-\u0024{b}-\u0024{c}",
        new Map([
          ["a", "\u0024{b}"],
          ["b", "2"],
        ]),
      ),
    ).toBe("2-2-\u0024{c}");
    expect(
      moduleOfPath("a/b/x.java", [
        { name: "root", dir: "." },
        { name: "a", dir: "a" },
        { name: "ab", dir: "a/b" },
      ]),
    ).toBe("ab");
  });
});

describe("entry points", () => {
  test("main, scheduled, listeners, message-driven, startup and runners; test code is not one", () => {
    const app = type("p.App", {
      methods: [
        method("main", { modifiers: ["public", "static"], parameters: [param("args", "String[]")], line: 3 }),
        method("main", { parameters: [param("args", "String[]")], line: 4 }), // not static
      ],
    });
    const jobs = type("p.Jobs", {
      methods: [
        method("nightly", { annotations: [ann("Scheduled", { cron: "0 0 2 * * *" })] }),
        method("onOrder", { annotations: [ann("KafkaListener", { topics: "orders" })] }),
        method("onQueue", { annotations: [ann("JmsListener", { destination: "q" })] }),
        method("onRabbit", { annotations: [ann("RabbitListener", { queues: "r" })] }),
        method("onEvent", { annotations: [ann("EventListener")], parameters: [param("e", "OrderPlaced")] }),
      ],
    });
    const mdb = type("p.Mdb", {
      annotations: [
        ann("MessageDriven", {
          activationConfig: {
            text: '{@ActivationConfigProperty(propertyName = "destinationLookup", propertyValue = "jms/q")}',
            items: [
              {
                text: '@ActivationConfigProperty(propertyName = "destinationLookup", propertyValue = "jms/q")',
              },
            ],
          },
        }),
      ],
    });
    const warm = type("p.Warm", { annotations: [ann("Singleton"), ann("Startup")] });
    const runner = type("p.Runner", { implements: ["CommandLineRunner"] });
    const inTest = type("p.TestApp", {
      methods: [method("main", { modifiers: ["static"], parameters: [param("a", "String...")] })],
    });
    const r = repo([
      ...[app, jobs, mdb, warm, runner].map((t) => file("m", [t])),
      file("m", [inTest], { test: true }),
    ]);
    expect(javaEntrypoints(r).map((e) => [e.kind, e.handler, e.detail ?? ""])).toEqual([
      ["main", "p.App#main", ""],
      ["scheduled", "p.Jobs#nightly", "cron=0 0 2 * * *"],
      ["kafka-listener", "p.Jobs#onOrder", "topics=orders"],
      ["jms-listener", "p.Jobs#onQueue", "destination=q"],
      ["rabbit-listener", "p.Jobs#onRabbit", "queues=r"],
      ["event-listener", "p.Jobs#onEvent", "OrderPlaced"],
      ["message-driven", "p.Mdb", "jms/q"],
      ["startup", "p.Warm", ""],
      ["startup", "p.Runner#run", "CommandLineRunner"],
    ]);
  });
});

describe("frameworks", () => {
  test("from dependencies, annotations and descriptors, with counts and evidence; absent ones are not listed", () => {
    const c = type("p.C", { annotations: [ann("RestController", {}, 3)] });
    const e = type("p.E", { annotations: [ann("Entity", {}, 4)] });
    const r = repo([file("api", [c]), file("api", [e])], {
      modules: [
        module("api", {
          dependencies: [
            {
              group: "org.springframework",
              artifact: "spring-web",
              version: "6",
              scope: "compile",
              line: 12,
            },
          ],
        }),
      ],
      descriptors: [
        {
          path: "api/WEB-INF/web.xml",
          facts: { servlets: [{ name: "s", className: "p.S", urlPatterns: [], line: 2 }] },
        },
      ],
    });
    const f = Object.fromEntries(javaFrameworks(r).map((x) => [x.name, x]));
    expect(Object.keys(f).sort()).toEqual(["jpa", "servlet", "spring-mvc"]);
    expect(f["spring-mvc"]).toEqual({
      name: "spring-mvc",
      count: 1,
      evidence: [
        { at: "api/pom.xml:12", source: "dependency org.springframework:spring-web" },
        { at: "api/src/main/java/p/C.java:3", source: "@RestController" },
      ],
    });
    expect(f.servlet?.evidence[0]).toEqual({ at: "api/WEB-INF/web.xml:2", source: "<servlet> s" });
  });
});
