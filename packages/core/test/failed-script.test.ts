import { describe, expect, test } from "bun:test";
import { failedScript } from "../src/application/drive.ts";

describe("failedScript", () => {
  test("names the script's last output", () => {
    expect(failedScript("gate `test -f x`", { tail: "no such file\n", exitCode: 1 })).toBe(
      "gate `test -f x`: no such file",
    );
  });

  test("a script that printed nothing is named by its exit code, never by a bare colon", () => {
    expect(failedScript("gate `test -f x`", { tail: "  \n", exitCode: 1 })).toBe(
      "gate `test -f x` with exit code 1",
    );
  });
});
