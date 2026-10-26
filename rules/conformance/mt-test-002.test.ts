/** MT-TEST-002: an adapter of a port that has a contract suite runs that suite in its tests. */
import { describe, expect, test } from "bun:test";
import { sources } from "./lib.ts";

/** `fileSystemContract` covers the `FileSystem` port. */
function contracts(suites: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const text of suites.values()) {
    for (const [, fn] of text.matchAll(/^export function (\w+Contract)\(/gm)) {
      const name = fn as string;
      out.set(`${name[0]?.toUpperCase()}${name.slice(1, -"Contract".length)}`, name);
    }
  }
  return out;
}

/** Adapters (`class X implements Port`) whose package tests never call `portContract("X", ...)`. */
function uncovered(
  suites: ReadonlyMap<string, string>,
  adapters: ReadonlyMap<string, string>,
  tests: ReadonlyMap<string, string>,
): string[] {
  const byPort = contracts(suites);
  const out: string[] = [];
  for (const [file, text] of adapters) {
    const pkg = file.split("/").slice(0, 2).join("/");
    const testText = [...tests]
      .filter(([f]) => f.startsWith(`${pkg}/`))
      .map(([, t]) => t)
      .join("\n");
    for (const [, cls, ports] of text.matchAll(/class (\w+) implements ([\w\s,]+?)\s*\{/g)) {
      for (const port of (ports as string).split(",").map((p) => p.trim())) {
        const fn = byPort.get(port);
        if (fn && !new RegExp(`\\b${fn}\\(\\s*["'\`]${cls}["'\`]`).test(testText)) {
          out.push(`${file}: ${cls} implements ${port} but its tests never call ${fn}("${cls}", ...)`);
        }
      }
    }
  }
  return out;
}

describe("MT-TEST-002", () => {
  test("every adapter of a port with a contract suite runs it", async () => {
    const suites = await sources("packages/testing/src/contracts/*.contract.ts");
    expect(contracts(suites).size).toBeGreaterThan(0);
    expect(
      uncovered(
        suites,
        await sources("packages/plugin-*/src/**/*.ts"),
        await sources("packages/plugin-*/test/**/*.ts"),
      ),
    ).toEqual([]);
  });

  test("rejects an adapter whose tests skip the contract suite", () => {
    const suites = new Map([["c.ts", "export function fileSystemContract(name: string, make: F): void {"]]);
    const adapters = new Map([
      ["packages/plugin-x/src/a.ts", "export class XFileSystem implements FileSystem {\n}"],
      ["packages/plugin-y/src/b.ts", "export class YFileSystem implements Vcs, FileSystem {\n}"],
      ["packages/plugin-z/src/c.ts", "export class ZVcs implements Vcs {\n}"],
    ]);
    const tests = new Map([
      ["packages/plugin-x/test/a.test.ts", 'test("reads", () => {});'],
      ["packages/plugin-y/test/b.test.ts", 'fileSystemContract("YFileSystem", make);'],
    ]);
    expect(uncovered(suites, adapters, tests)).toEqual([
      'packages/plugin-x/src/a.ts: XFileSystem implements FileSystem but its tests never call fileSystemContract("XFileSystem", ...)',
    ]);
  });
});
