import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { visibleOptions } from "../src/commands/meta.ts";
import { FLAG_NAMES, renamedOption } from "../src/options.ts";
import { buildProgram } from "../src/program.ts";

/** Every command of the tree with its words (`rules pack`). */
function commands(program: Command): { name: string; cmd: Command }[] {
  const out: { name: string; cmd: Command }[] = [];
  const walk = (cmd: Command, prefix: string) => {
    for (const sub of cmd.commands) {
      out.push({ name: `${prefix}${sub.name()}`, cmd: sub });
      walk(sub, `${prefix}${sub.name()} `);
    }
  };
  walk(program, "");
  return out;
}

/** The visible options that use a spelling the CLI gave up, as `command --flag (use --other)`. */
const otherSpellings = (program: Command): string[] =>
  commands(program).flatMap(({ name, cmd }) =>
    visibleOptions(cmd)
      .filter((o) => o.long !== undefined && o.long in FLAG_NAMES)
      .map((o) => `${name} ${o.long} (use ${FLAG_NAMES[o.long as string]})`),
  );

describe("one flag name per meaning (B12)", () => {
  const program = buildProgram(() => {});

  test("no command shows --paths or --timeout-ms", () => {
    expect(commands(program).length).toBeGreaterThan(100);
    expect(otherSpellings(program)).toEqual([]);
  });

  test("a command that introduces the other spelling is named", () => {
    const fresh = buildProgram(() => {});
    const group = fresh.command("zz");
    group.command("scan").option("--paths <files...>", "files");
    group.command("wait").option("--timeout-ms <ms>", "limit").option("--timeout <ms>", "limit");
    expect(otherSpellings(fresh)).toEqual([
      "zz scan --paths (use --files)",
      "zz wait --timeout-ms (use --timeout)",
    ]);
  });

  test("the old spellings still parse, hidden, on the commands that had them", () => {
    const hidden = commands(program).flatMap(({ name, cmd }) =>
      cmd.options
        .filter((o) => o.hidden && o.long !== undefined && o.long in FLAG_NAMES)
        .map((o) => `${name} ${o.long}`),
    );
    expect(hidden).toEqual(["rules pack --paths", "eval run --timeout-ms"]);
    const o = renamedOption("--paths <files...>", "--files");
    expect([o.hidden, o.description]).toEqual([true, "the old name of --files"]);
  });
});
