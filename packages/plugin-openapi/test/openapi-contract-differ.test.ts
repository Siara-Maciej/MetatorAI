import { expect, test } from "bun:test";
import { contractDifferContract } from "@metator/testing";
import { OpenApiContractDiffer } from "../src/openapi-contract-differ.ts";

const spec = (version = "3.0.3", extra = "") => `openapi: ${version}
info: { title: Billing API, version: 1.2.0 }
paths:
  /invoices:
    get:
      parameters:
        - { name: q, in: query, schema: { type: string } }
        - { name: limit, in: query, required: false, schema: { type: integer } }
${extra}      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Invoice" }
  /refunds:
    post:
      responses: { "201": { description: created } }
components:
  schemas:
    Invoice: { type: object, properties: { id: { type: string }, total: { type: number } }, required: [id, total] }
`;
const V1 = spec();
const differ = new OpenApiContractDiffer();
const side = (text: string) => ({ path: "openapi.yaml", text });
const changes = async (a: string, b: string) =>
  (await differ.compare(side(a), side(b)))._unsafeUnwrap().changes.map((c) => [c.code, c.severity]);

contractDifferContract("OpenApiContractDiffer", () => new OpenApiContractDiffer(), {
  base: V1,
  compatible: V1.replace(
    "paths:\n",
    'paths:\n  /credits:\n    get:\n      responses: { "200": { description: ok } }\n',
  ),
  breaking: V1.replace('  /refunds:\n    post:\n      responses: { "201": { description: created } }\n', ""),
  invalid: "openapi: 3.0.3\npaths: 7\n",
});

test("operations: removed is breaking, added is not; the versions come from info", async () => {
  const v2 = V1.replace("  /refunds:\n    post:", "  /credits:\n    post:").replace("1.2.0", "2.0.0");
  const r = (await differ.compare(side(V1), side(v2)))._unsafeUnwrap();
  expect(r.versions).toEqual({ before: "1.2.0", after: "2.0.0" });
  expect(r.changes.map((c) => [c.code, c.severity, c.location])).toEqual([
    ["operation.remove", "breaking", "paths./refunds.post"],
    ["operation.add", "non-breaking", "paths./credits.post"],
  ]);
  expect(r.changes[0]?.message).toBe("[Removed] operation POST /refunds");
});

test("parameters: made required, removed or a new required one is breaking; a new optional one is not", async () => {
  expect(await changes(V1, V1.replace("required: false", "required: true"))).toEqual([
    ["parameter.add", "breaking"],
  ]);
  expect(
    await changes(V1, V1.replace("        - { name: q, in: query, schema: { type: string } }\n", "")),
  ).toEqual([["parameter.remove", "breaking"]]);
  expect(
    await changes(
      V1,
      spec("3.0.3", "        - { name: x, in: header, required: true, schema: { type: string } }\n"),
    ),
  ).toEqual([["parameter.add", "breaking"]]);
  expect(
    await changes(V1, spec("3.0.3", "        - { name: page, in: query, schema: { type: integer } }\n")),
  ).toEqual([["parameter.add", "non-breaking"]]);
});

test("types: narrowing what a consumer sends or widening what it receives is breaking", async () => {
  expect(
    await changes(
      V1,
      V1.replace(
        "{ name: q, in: query, schema: { type: string } }",
        "{ name: q, in: query, schema: { type: integer } }",
      ),
    ),
  ).toEqual([["parameter.replace", "breaking"]]);
  expect(await changes(V1, V1.replace("{ type: integer }", "{ type: number }"))).toEqual([
    ["parameter.replace", "non-breaking"],
  ]);
  expect(await changes(V1, V1.replace("total: { type: number }", "total: { type: integer }"))).toEqual([
    ["response.replace", "non-breaking"],
  ]);
  expect(await changes(V1, V1.replace("total: { type: number }", "total: { type: string }"))).toEqual([
    ["response.replace", "breaking"],
  ]);
});

test("a response field that is no longer required is breaking, through the $ref", async () => {
  const optional = await changes(V1, V1.replace("required: [id, total]", "required: [id]"));
  expect(optional[0]).toEqual(["response.remove", "breaking"]);
});

test("OpenAPI 3.1 is compared the same way", async () => {
  const v31 = spec("3.1.0");
  expect(await changes(v31, v31.replace("required: false", "required: true"))).toEqual([
    ["parameter.add", "breaking"],
  ]);
});

test("Swagger 2 is converted and compared: a parameter made required is breaking", async () => {
  const swagger = (req: string, path = "/a") =>
    `swagger: "2.0"\ninfo: { title: S, version: "1" }\npaths:\n  ${path}:\n    get:\n      parameters: [{ name: q, in: query, type: string, required: ${req} }]\n      responses: { "200": { description: ok } }\n`;
  expect(await changes(swagger("false"), swagger("true"))).toEqual([["parameter.add", "breaking"]]);
  expect(await changes(swagger("false"), swagger("false", "/b"))).toEqual([
    ["operation.remove", "breaking"],
    ["operation.add", "non-breaking"],
  ]);
});

test("an identical specification has no changes; text that is not one is PARSE_FAILED, never a throw", async () => {
  expect(await changes(V1, V1)).toEqual([]);
  for (const bad of ["x: [", "just: text", "openapi: 2.5\npaths: {}\n", "openapi: 3.0.3\npaths: 7\n"]) {
    const e = (await differ.compare(side(bad), side(V1)))._unsafeUnwrapErr();
    expect([bad, e.code, e.message.startsWith("openapi.yaml: ")]).toEqual([bad, "PARSE_FAILED", true]);
  }
});
