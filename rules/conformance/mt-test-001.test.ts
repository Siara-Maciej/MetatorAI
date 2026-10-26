/** MT-TEST-001: every CLI command is run by an e2e test of the real `metator` process. */
import { describe, expect, test } from "bun:test";
import { buildProgram } from "../../packages/cli/src/program.ts";
import { sources } from "./lib.ts";

type Command = ReturnType<typeof buildProgram>;

/** Leaf command paths, e.g. ["graph", "cycles"]. */
function leaves(program: Command): string[][] {
  const out: string[][] = [];
  const walk = (c: Command, path: string[]) => {
    if (c.commands.length === 0) out.push(path);
    for (const sub of c.commands) walk(sub, [...path, sub.name()]);
  };
  for (const c of program.commands) walk(c, [c.name()]);
  return out;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Commands whose argv (`"graph", "cycles"`) appears in no e2e test. */
function untested(commands: readonly string[][], e2e: ReadonlyMap<string, string>): string[] {
  const text = [...e2e.values()].join("\n");
  return commands
    .filter((path) => !new RegExp(`["'\`]${path.map(literal).join(`["'\`],\\s*["'\`]`)}["'\`]`).test(text))
    .map((path) => path.join(" "));
}

describe("MT-TEST-001", () => {
  test("every command has an e2e test", async () => {
    const commands = leaves(buildProgram(() => {}));
    expect(commands.length).toBeGreaterThan(40);
    expect(untested(commands, await sources("e2e/*.e2e.test.ts"))).toEqual([]);
  });

  test("rejects a command that only unit tests run", () => {
    const e2e = new Map([["e2e/graph.e2e.test.ts", 'await metator(["graph",\n  "cycles"], root);']]);
    expect(
      untested(
        [
          ["graph", "cycles"],
          ["graph", "path"],
        ],
        e2e,
      ),
    ).toEqual(["graph path"]);
  });
});
