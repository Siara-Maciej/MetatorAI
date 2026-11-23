import { describe, expect, test } from "bun:test";
import {
  jaxrsEndpoints,
  joinPaths,
  routerEndpoints,
  servletEndpoints,
  springEndpoints,
  unwrapResponse,
} from "../src/index.ts";
import { ann, file, method, module, param, repo, type } from "./fixtures/java.ts";

const imports = (...names: string[]) =>
  names.map((name, i) => ({ name, static: false, onDemand: false, line: i + 1 }));

describe("Spring MVC endpoints", () => {
  const controller = type("com.shop.api.OrderController", {
    annotations: [ann("RestController", {}, 5), ann("RequestMapping", "/api/orders", 6)],
    methods: [
      method("get", {
        returnType: "ResponseEntity<OrderDto>",
        annotations: [ann("GetMapping", "/{id}", 10)],
        parameters: [param("id", "Long", ann("PathVariable"))],
        line: 11,
      }),
      method("create", {
        returnType: "ResponseEntity<OrderDto>",
        annotations: [ann("PostMapping", { consumes: "application/json" }, 14)],
        parameters: [
          param("body", "CreateOrder", ann("RequestBody")),
          param("rid", "String", ann("RequestHeader", "X-Request-Id")),
          param("page", "int", ann("RequestParam", { required: false })),
        ],
      }),
      method("both", {
        annotations: [
          ann("RequestMapping", { path: "/both", method: ["=RequestMethod.GET", "=RequestMethod.PUT"] }),
        ],
      }),
      method("any", { annotations: [ann("RequestMapping", "/any")] }),
      method("helper", { annotations: [] }),
    ],
  });
  const dto = type("com.shop.api.OrderDto", { kind: "record" });
  const create = type("com.shop.api.CreateOrder", { kind: "record" });
  const r = repo([file("api", [controller]), file("api", [dto]), file("api", [create])]);

  test("class path joined with method path, HTTP method, parameters, body and unwrapped response", () => {
    const e = springEndpoints(r);
    expect(e.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /api/orders/{id}",
      "POST /api/orders",
      "GET /api/orders/both",
      "PUT /api/orders/both",
      "* /api/orders/any",
    ]);
    expect(e[0]).toMatchObject({
      framework: "spring-mvc",
      handler: "com.shop.api.OrderController#get",
      module: "api",
      at: "api/src/main/java/com/shop/api/OrderController.java:11",
      responseType: "com.shop.api.OrderDto",
      parameters: [{ name: "id", in: "path", type: "Long" }],
      confidence: "certain",
    });
    expect(e[0]?.evidence).toEqual([
      {
        at: "api/src/main/java/com/shop/api/OrderController.java:6",
        source: '@RequestMapping("/api/orders")',
      },
      { at: "api/src/main/java/com/shop/api/OrderController.java:10", source: '@GetMapping("/{id}")' },
    ]);
    expect(e[1]).toMatchObject({
      requestType: "com.shop.api.CreateOrder",
      consumes: ["application/json"],
      parameters: [
        { name: "body", in: "body", type: "com.shop.api.CreateOrder", required: true },
        { name: "X-Request-Id", in: "header", type: "String", required: true },
        { name: "page", in: "query", type: "int", required: false },
      ],
    });
  });

  test("a path built from a constant is read from the constant and is only likely", () => {
    const paths = type("com.shop.api.Paths", {
      fields: [
        {
          name: "CUSTOMERS",
          type: "String",
          modifiers: ["public", "static", "final"],
          annotations: [],
          line: 2,
          value: { text: '"/c"', value: "/c" },
        },
      ],
    });
    const c = type("com.shop.api.CustomerController", {
      annotations: [ann("Controller"), ann("RequestMapping", { path: "=Paths.CUSTOMERS" })],
      methods: [
        method("get", {
          returnType: "CustomerDto",
          annotations: [ann("GetMapping", "/{id}"), ann("ResponseBody")],
        }),
      ],
    });
    const e = springEndpoints(repo([file("api", [paths]), file("api", [c])]));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ path: "/c/{id}", confidence: "likely", responseType: "CustomerDto" });
  });

  test("a @Controller method without @ResponseBody renders a view: no response type", () => {
    const c = type("p.Pages", {
      annotations: [ann("Controller")],
      methods: [method("home", { returnType: "String", annotations: [ann("GetMapping", "/")] })],
    });
    expect(springEndpoints(repo([file("web", [c])]))[0]).not.toHaveProperty("responseType");
  });

  test("a class that is not a controller has no endpoints, even with mapping annotations", () => {
    const notController = type("p.Client", {
      methods: [method("x", { annotations: [ann("GetMapping", "/x")] })],
    });
    expect(springEndpoints(repo([file("m", [notController])]))).toEqual([]);
  });

  test("WebFlux annotated controllers: Mono<T> is T, Flux<T> is T[]", () => {
    const c = type("p.Products", {
      annotations: [ann("RestController")],
      methods: [
        method("all", { returnType: "Flux<ProductView>", annotations: [ann("GetMapping")] }),
        method("one", {
          returnType: "Mono<ResponseEntity<ProductView>>",
          annotations: [ann("GetMapping", "/{sku}")],
        }),
      ],
    });
    const e = springEndpoints(repo([file("rx", [c])]));
    expect(e.map((x) => [x.framework, x.path, x.responseType])).toEqual([
      ["webflux", "/", "ProductView[]"],
      ["webflux", "/{sku}", "ProductView"],
    ]);
  });

  test("unwrapResponse and joinPaths", () => {
    expect(unwrapResponse("ResponseEntity<List<Order>>")).toBe("List<Order>");
    expect(unwrapResponse("void")).toBeUndefined();
    expect(unwrapResponse("ResponseEntity<Void>")).toBeUndefined();
    expect(unwrapResponse("CompletableFuture<Order>")).toBe("Order");
    expect(joinPaths("/api/", "/x/")).toBe("/api/x");
    expect(joinPaths("", "")).toBe("/");
  });
});

describe("WebFlux RouterFunction routes", () => {
  test("builder and static routes, handlers through the method's parameter; always likely", () => {
    const routes = type("p.Routes", {
      methods: [method("routes", { parameters: [param("handler", "ProductHandler")], line: 3 })],
    });
    const handler = type("p.ProductHandler");
    const f = file("rx", [routes], {
      calls: [
        { name: "route", arguments: [], line: 4, within: 1, in: "p.Routes#routes" },
        {
          name: "GET",
          arguments: [{ text: '"/fn/products"', value: "/fn/products" }, { text: "handler::list" }],
          line: 5,
          in: "p.Routes#routes",
        },
        {
          name: "route",
          arguments: [{ text: 'GET("/fn/health")' }, { text: "handler::health" }],
          line: 8,
          in: "p.Routes#routes",
        },
        {
          name: "GET",
          arguments: [{ text: '"/fn/health"', value: "/fn/health" }],
          line: 8,
          within: 2,
          in: "p.Routes#routes",
        },
        { name: "GET", arguments: [{ text: "PATH" }], line: 9, in: "p.Routes#routes" },
      ],
    });
    const e = routerEndpoints(repo([f, file("rx", [handler])]));
    expect(e.map((x) => [x.method, x.path, x.handler, x.confidence])).toEqual([
      ["GET", "/fn/products", "p.ProductHandler#list", "likely"],
      ["GET", "/fn/health", "p.ProductHandler#health", "likely"],
    ]);
  });
});

describe("JAX-RS endpoints", () => {
  const app = type("p.App", { annotations: [ann("ApplicationPath", "/legacy")], extends: ["Application"] });
  const resource = type("p.InvoiceResource", {
    annotations: [ann("Path", "/invoices"), ann("Produces", "=MediaType.APPLICATION_JSON")],
    methods: [
      method("get", {
        returnType: "Invoice",
        annotations: [ann("GET"), ann("Path", "/{id}")],
        parameters: [param("id", "long", ann("PathParam", "id"))],
      }),
      method("create", {
        returnType: "Response",
        annotations: [ann("POST"), ann("Consumes", "application/xml")],
        parameters: [param("invoice", "Invoice"), param("ui", "UriInfo", ann("Context"))],
      }),
      method("locator", { annotations: [ann("Path", "/sub")] }),
    ],
  });

  test("@ApplicationPath + class @Path + method @Path; parameters; un-annotated parameter is the body", () => {
    const e = jaxrsEndpoints(repo([file("legacy", [app]), file("legacy", [resource])]));
    expect(e.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /legacy/invoices/{id}",
      "POST /legacy/invoices",
    ]);
    expect(e[0]).toMatchObject({
      framework: "jax-rs",
      produces: ["application/json"],
      responseType: "Invoice",
      parameters: [{ name: "id", in: "path" }],
    });
    expect(e[1]).toMatchObject({
      requestType: "Invoice",
      consumes: ["application/xml"],
      parameters: [{ name: "invoice", in: "body" }],
    });
    expect(e[1]).not.toHaveProperty("responseType");
  });

  test("methods without an HTTP method annotation (sub-resource locators) and classes without @Path are not endpoints", () => {
    const noPath = type("p.Helper", { methods: [method("x", { annotations: [ann("GET")] })] });
    expect(jaxrsEndpoints(repo([file("legacy", [noPath])]))).toEqual([]);
  });
});

describe("Servlets", () => {
  test("@WebServlet patterns and web.xml mappings, methods from the doX overrides", () => {
    const status = type("p.StatusServlet", {
      annotations: [ann("WebServlet", { urlPatterns: ["/status", "/health"] })],
      methods: [method("doGet", { modifiers: ["protected"] })],
    });
    const report = type("p.ReportServlet", { methods: [method("doGet"), method("doPost")] });
    const r = repo([file("legacy", [status]), file("legacy", [report])], {
      descriptors: [
        {
          path: "legacy/src/main/webapp/WEB-INF/web.xml",
          module: "legacy",
          facts: {
            servlets: [
              { name: "reports", className: "p.ReportServlet", urlPatterns: ["/reports/*"], line: 7 },
            ],
          },
        },
      ],
    });
    expect(servletEndpoints(r).map((x) => `${x.method} ${x.path} ${x.handler} ${x.at}`)).toEqual([
      "GET /status p.StatusServlet legacy/src/main/java/p/StatusServlet.java:1",
      "GET /health p.StatusServlet legacy/src/main/java/p/StatusServlet.java:1",
      "GET /reports/* p.ReportServlet legacy/src/main/webapp/WEB-INF/web.xml:7",
      "POST /reports/* p.ReportServlet legacy/src/main/webapp/WEB-INF/web.xml:7",
    ]);
  });

  test("a servlet class outside the repository answers any method", () => {
    const r = repo([], {
      modules: [module("w")],
      descriptors: [
        {
          path: "w/web.xml",
          facts: { servlets: [{ name: "x", className: "org.lib.X", urlPatterns: ["/x"], line: 1 }] },
        },
      ],
    });
    expect(servletEndpoints(r).map((x) => x.method)).toEqual(["*"]);
  });
});

test("type names resolve through single-type imports, the package and on-demand imports", () => {
  const order = type("com.shop.domain.Order");
  const c = type("com.shop.api.C", {
    annotations: [ann("RestController")],
    methods: [method("get", { returnType: "List<Order>", annotations: [ann("GetMapping")] })],
  });
  const r = repo([
    file("d", [order]),
    file("a", [c], { imports: imports("com.shop.domain.Order", "java.util.List") }),
  ]);
  expect(springEndpoints(r)[0]?.responseType).toBe("List<com.shop.domain.Order>");
});
