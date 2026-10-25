import { describe, expect, test } from "bun:test";
import { MetatorError } from "../src/domain/errors.ts";

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
