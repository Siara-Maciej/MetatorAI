import { describe, expect, test } from "bun:test";
import { matchesAny, normalizePath } from "../src/domain/glob.ts";

describe("matchesAny: glob semantics we rely on (picomatch)", () => {
  const cases: [glob: string, path: string, expected: boolean][] = [
    ["packages/*/src/**", "packages/billing/src/a/b.ts", true],
    ["packages/*/src/**", "packages/billing/test/a.ts", false],
    ["**/*.test.ts", "a.test.ts", true],
    ["**/*.test.ts", "deep/nested/x.test.ts", true],
    ["**/*.test.ts", "x.test.tsx", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/nested/a.ts", false],
    ["**/*.{ts,tsx}", "ui/Button.tsx", true],
    ["file?.md", "file1.md", true],
    ["file?.md", "file10.md", false],
    ["a.b/c+d.ts", "a.b/c+d.ts", true],
    ["a.b/c+d.ts", "aXb/c+d.ts", false],
    ["**/*", ".github/workflows/ci.yml", true],
    [".github/**", ".github/agents/mt-planner.agent.md", true],
  ];
  for (const [glob, path, expected] of cases) {
    test(`${glob} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(matchesAny(path, [glob])).toBe(expected);
    });
  }
});

describe("matchesAny", () => {
  test("negated pattern wins over a positive match", () => {
    expect(matchesAny("src/gen/x.ts", ["src/**", "!src/gen/**"])).toBe(false);
    expect(matchesAny("src/app/x.ts", ["src/**", "!src/gen/**"])).toBe(true);
  });

  test("no positive pattern means no match", () => {
    expect(matchesAny("src/a.ts", ["!src/gen/**"])).toBe(false);
  });

  test("normalizes Windows separators and leading ./", () => {
    expect(normalizePath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(matchesAny(".\\src\\a.ts", ["src/*.ts"])).toBe(true);
  });
});
