import { describe, expect, test } from "bun:test";
import { MetatorError } from "../src/domain/errors.ts";
import { andThen, err, map, ok, type Result } from "../src/domain/result.ts";

describe("Result", () => {
  test("map transforms Ok and passes Err through untouched", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    const failure = err(MetatorError.usage("bad"));
    expect(map(failure as Result<number, MetatorError>, (n) => n * 3)).toBe(failure);
  });

  test("andThen chains async steps and short-circuits on the first Err", async () => {
    const calls: string[] = [];
    const step =
      (name: string, fail = false) =>
      async (n: number): Promise<Result<number, MetatorError>> => {
        calls.push(name);
        return fail ? err(new MetatorError("INTERNAL", name)) : ok(n + 1);
      };
    const chained = await andThen(await andThen(ok(0), step("a")), step("b"));
    expect(chained).toEqual(ok(2));

    calls.length = 0;
    const failed = await andThen(await andThen(ok(0), step("a", true)), step("b"));
    expect(failed.ok).toBe(false);
    expect(calls).toEqual(["a"]);
  });
});

describe("MetatorError", () => {
  test("factories set code, message and hint", () => {
    const e = MetatorError.usage("Unknown flag --x", "See `metator help`.");
    expect(e).toBeInstanceOf(Error);
    expect([e.code, e.message, e.hint]).toEqual(["USAGE", "Unknown flag --x", "See `metator help`."]);
    expect(MetatorError.notFound("File a.ts", { path: "a.ts" }).details).toEqual({ path: "a.ts" });
  });

  test("toJSON omits absent optional fields and never leaks the stack", () => {
    expect(JSON.parse(JSON.stringify(new MetatorError("INTERNAL", "boom")))).toEqual({
      code: "INTERNAL",
      message: "boom",
    });
    const withHint = JSON.parse(JSON.stringify(MetatorError.usage("x", "y")));
    expect(withHint).toEqual({ code: "USAGE", message: "x", hint: "y" });
    expect(JSON.stringify(withHint)).not.toContain("stack");
  });
});
