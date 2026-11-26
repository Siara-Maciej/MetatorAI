import { describe, expect, test } from "bun:test";
import { describeCommandFor } from "../src/commands/meta.ts";
import { buildProgram } from "../src/program.ts";

const program = buildProgram(() => {});
const helpName = (...argv: string[]) => describeCommandFor(program, argv)?.name;

describe("metator <command> --help", () => {
  test("--help or -h anywhere among the command's words is its help", () => {
    expect(helpName("issue", "add", "--help")).toBe("issue add");
    expect(helpName("issue", "add", "x", "-h")).toBe("issue add");
    expect(helpName("issue", "add", "x", "--body", "b", "--help")).toBe("issue add");
    expect(helpName("-C", "/repo", "serve", "--help")).toBe("serve");
  });

  test("--help as the value of an option that takes one is that value, not a request for help", () => {
    expect(helpName("issue", "add", "x", "--body", "--help")).toBeUndefined();
    expect(helpName("issue", "add", "x", "--body", "-h", "--by", "ada")).toBeUndefined();
    expect(helpName("issue", "add", "x", "--ref", "a", "--by", "-h")).toBeUndefined();
    expect(helpName("issue", "add", "x", "--body=--help")).toBeUndefined();
    // After the value, a flag of its own is help again; an option without a value takes none.
    expect(helpName("issue", "add", "x", "--body", "--help", "--help")).toBe("issue add");
    expect(helpName("doctor", "--gates", "--help")).toBe("doctor");
    // Past `--` nothing is an option.
    expect(helpName("issue", "add", "--", "--help")).toBeUndefined();
  });
});
