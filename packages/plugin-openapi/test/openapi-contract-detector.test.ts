import { describe, expect, test } from "bun:test";
import { OpenApiContractDetector } from "../src/openapi-contract-detector.ts";

const detect = (text: string, path = "api/openapi.yaml") =>
  new OpenApiContractDetector().detect(path, text)._unsafeUnwrap();

describe("OpenApiContractDetector", () => {
  test("OpenAPI 3 in YAML: title, version and servers", () => {
    expect(
      detect(
        "openapi: 3.1.0\ninfo:\n  title: Billing API\n  version: 2.1.0\nservers:\n  - url: https://billing.example.com/v2\n  - description: no url\n",
      ),
    ).toEqual({
      path: "api/openapi.yaml",
      title: "Billing API",
      version: "2.1.0",
      servers: ["https://billing.example.com/v2"],
    });
  });

  test("Swagger 2 in JSON: the server from host, scheme and base path", () => {
    const text = JSON.stringify({
      swagger: "2.0",
      info: { title: "Legacy", version: 1 },
      host: "legacy.example.com",
      basePath: "/api",
      schemes: ["http"],
    });
    expect(detect(text, "legacy.json")).toEqual({
      path: "legacy.json",
      title: "Legacy",
      version: "1",
      servers: ["http://legacy.example.com/api"],
    });
    expect(
      detect(JSON.stringify({ swagger: "2.0", info: {}, host: "h.example.com" }), "x.json")?.servers,
    ).toEqual(["https://h.example.com"]);
  });

  test("not a specification: other YAML, another version, broken text; a title falls back to the path", () => {
    expect(detect("kind: Workflow\nopenapi_like: true\n")).toBeUndefined();
    expect(detect("name: app\n")).toBeUndefined();
    expect(detect("openapi: 4.0.0\n")).toBeUndefined();
    expect(detect("openapi: [\n")).toBeUndefined();
    expect(detect("openapi: 3.0.0\ninfo: {}\n")?.title).toBe("api/openapi.yaml");
    expect(new OpenApiContractDetector().kind).toBe("openapi");
  });
});
