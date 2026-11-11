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

/**
 * Doubles that replay scripted answers instead of doing the port's work. The suite of their port
 * checks that work (real processes), so it cannot run on them.
 */
const SCRIPTED: ReadonlySet<string> = new Set(["ScriptedProcessRunner"]);

/** Adapters (`class X implements Port`) whose package tests never call `portContract("X", ...)`. */
function uncovered(
  suites: ReadonlyMap<string, string>,
  adapters: ReadonlyMap<string, string>,
  tests: ReadonlyMap<string, string>,
  scripted: ReadonlySet<string> = new Set(),
): string[] {
  const byPort = contracts(suites);
  const out: string[] = [];
  for (const [file, text] of adapters) {
    const pkg = file.split("/").slice(0, 2).join("/");
    const testText = [...tests]
      .filter(([f]) => f.startsWith(`${pkg}/`))
      .map(([, t]) => t)
      .join("\n");
    for (const [, cls, ports] of text.matchAll(/class (\w+)\s+implements ([\w\s,]+?)\s*\{/g)) {
      for (const port of (ports as string).split(",").map((p) => p.trim())) {
        const fn = byPort.get(port);
        if (
          fn &&
          !scripted.has(cls as string) &&
          !new RegExp(`\\b${fn}\\(\\s*["'\`]${cls}["'\`]`).test(testText)
        ) {
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
        // The fakes in packages/testing are adapters too: a fake that drifts from its port hides bugs.
        await sources("packages/{plugin-*,testing}/src/**/*.ts"),
        await sources("packages/{plugin-*,testing}/test/**/*.ts"),
        SCRIPTED,
      ),
    ).toEqual([]);
  });

  test("rejects an adapter whose tests skip the contract suite", () => {
    const suites = new Map([["c.ts", "export function fileSystemContract(name: string, make: F): void {"]]);
    const adapters = new Map([
      ["packages/plugin-x/src/a.ts", "export class XFileSystem implements FileSystem {\n}"],
      ["packages/plugin-y/src/b.ts", "export class YFileSystem implements Vcs, FileSystem {\n}"],
      ["packages/plugin-z/src/c.ts", "export class ZVcs implements Vcs {\n}"],
      ["packages/plugin-w/src/d.ts", "export class WFileSystem\n  implements Vcs, FileSystem\n{\n}"],
      ["packages/testing/src/fakes.ts", "export class FakeFileSystem implements FileSystem {\n}"],
    ]);
    const tests = new Map([
      ["packages/plugin-x/test/a.test.ts", 'test("reads", () => {});'],
      ["packages/plugin-y/test/b.test.ts", 'fileSystemContract("YFileSystem", make);'],
    ]);
    expect(uncovered(suites, adapters, tests)).toEqual([
      'packages/plugin-x/src/a.ts: XFileSystem implements FileSystem but its tests never call fileSystemContract("XFileSystem", ...)',
      'packages/plugin-w/src/d.ts: WFileSystem implements FileSystem but its tests never call fileSystemContract("WFileSystem", ...)',
      'packages/testing/src/fakes.ts: FakeFileSystem implements FileSystem but its tests never call fileSystemContract("FakeFileSystem", ...)',
    ]);
  });
});
