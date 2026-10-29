import { expect, test } from "bun:test";
import { contractDifferContract } from "@metator/testing";
import { OpenApiContractDiffer } from "../src/openapi-contract-differ.ts";

const V1 = `openapi: 3.0.3
info: { title: Billing API, version: 1.2.0 }
paths:
  /invoices:
    get:
      responses: { "200": { description: ok } }
  /refunds:
    post:
      responses: { "201": { description: created } }
`;
const differ = new OpenApiContractDiffer();

contractDifferContract("OpenApiContractDiffer", () => new OpenApiContractDiffer(), {
  base: V1,
  compatible: V1.replace(
    "paths:\n",
    'paths:\n  /credits:\n    get:\n      responses: { "200": { description: ok } }\n',
  ),
  breaking: V1.replace('  /refunds:\n    post:\n      responses: { "201": { description: created } }\n', ""),
  invalid: "openapi: 3.0.3\npaths: 7\n",
});
const side = (text: string) => ({ path: "openapi.yaml", text });

test("a removed path is breaking, an added one is not, and the versions come from info", async () => {
  const v2 = V1.replace(
    '  /refunds:\n    post:\n      responses: { "201": { description: created } }\n',
    '  /credits:\n    get:\n      responses: { "200": { description: ok } }\n',
  ).replace("1.2.0", "2.0.0");
  const r = (await differ.compare(side(V1), side(v2)))._unsafeUnwrap();
  expect(r.versions).toEqual({ before: "1.2.0", after: "2.0.0" });
  expect(r.changes.map((c) => [c.code, c.severity, c.location])).toEqual([
    ["path.remove", "breaking", "paths./refunds"],
    ["path.add", "non-breaking", "paths./credits"],
  ]);
  expect(r.changes[0]?.message).toBe("removed path at paths./refunds");
});

test("Swagger 2 is compared as Swagger; an identical specification has no changes", async () => {
  const swagger = `swagger: "2.0"\ninfo: { title: S, version: "1" }\npaths:\n  /a: { get: { responses: { "200": { description: ok } } } }\n`;
  const removed = (await differ.compare(side(swagger), side(swagger.replace("/a:", "/b:"))))._unsafeUnwrap();
  expect(removed.changes.map((c) => c.code)).toEqual(["path.remove", "path.add"]);
  expect((await differ.compare(side(V1), side(V1)))._unsafeUnwrap().changes).toEqual([]);
});

test("text that is not a specification is PARSE_FAILED, never a throw", async () => {
  expect((await differ.compare(side("x: ["), side(V1)))._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  const invalid = (await differ.compare(side(V1), side("openapi: 3.0.3\npaths: 7\n")))._unsafeUnwrapErr();
  expect([invalid.code, invalid.message.length > 0]).toEqual(["PARSE_FAILED", true]);
});
