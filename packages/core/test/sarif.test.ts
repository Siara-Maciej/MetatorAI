import { describe, expect, test } from "bun:test";
import { diagnosticsFromSarif, type SarifLog } from "../src/domain/sarif.ts";

const result = (
  uri: string | undefined,
  extra: Record<string, unknown> = {},
): NonNullable<NonNullable<SarifLog["runs"]>[number]["results"]>[number] => ({
  ruleId: "lint/suspicious/noDebugger",
  level: "error",
  message: { text: "no debugger" },
  locations: uri
    ? [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3, startColumn: 2 } } }]
    : [],
  ...extra,
});

describe("diagnosticsFromSarif", () => {
  test("absolute, file:// and relative URIs become repo-relative paths", () => {
    const log: SarifLog = {
      runs: [
        {
          results: [
            result("/repo/src/a.ts"),
            result("file:///repo/src/b%20c.ts"),
            result("src/d.ts"),
            result("/elsewhere/e.ts"),
          ],
        },
      ],
    };
    expect(diagnosticsFromSarif(log, "/repo/", "biome").map((d) => d.file)).toEqual([
      "/elsewhere/e.ts",
      "src/a.ts",
      "src/b c.ts",
      "src/d.ts",
    ]);
  });

  test("levels map to severities; position, rule and message are kept", () => {
    const log: SarifLog = {
      runs: [
        {
          results: [
            result("/r/a.ts", { level: "warning" }),
            result("/r/b.ts", { level: "note" }),
            result("/r/c.ts", { level: undefined }),
          ],
        },
      ],
    };
    expect(diagnosticsFromSarif(log, "/r", "biome")).toEqual([
      {
        source: "biome",
        toolRuleId: "lint/suspicious/noDebugger",
        file: "a.ts",
        line: 3,
        column: 2,
        severity: "warning",
        message: "no debugger",
      },
      {
        source: "biome",
        toolRuleId: "lint/suspicious/noDebugger",
        file: "b.ts",
        line: 3,
        column: 2,
        severity: "info",
        message: "no debugger",
      },
      {
        source: "biome",
        toolRuleId: "lint/suspicious/noDebugger",
        file: "c.ts",
        line: 3,
        column: 2,
        severity: "warning",
        message: "no debugger",
      },
    ]);
  });

  test("results without a location are skipped; empty logs are fine", () => {
    expect(diagnosticsFromSarif({ runs: [{ results: [result(undefined)] }] }, "/r", "x")).toEqual([]);
    expect(diagnosticsFromSarif({}, "/r", "x")).toEqual([]);
  });
});
