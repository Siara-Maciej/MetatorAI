import { describe, expect, test } from "bun:test";
import { err, MetatorError, ok } from "@metator/core";
import { BY_DEFAULT, baseOption, byOption, defined, runGiven, runOption } from "../src/options.ts";
import { failWhen } from "../src/outcome.ts";
import { whoFrom } from "../src/who.ts";

describe("the helpers every command shares", () => {
  test("who acts: --by, then $METATOR_USER, git's user.name, the login name; nobody is a usage error", () => {
    const env = { METATOR_USER: "env", USER: "login", USERNAME: "winlogin" };
    expect(whoFrom("ada", env, "Git Name")._unsafeUnwrap()).toBe("ada");
    expect(whoFrom(undefined, env, "Git Name")._unsafeUnwrap()).toBe("env");
    expect(whoFrom(undefined, { USER: "login" }, "Git Name\n")._unsafeUnwrap()).toBe("Git Name");
    expect(whoFrom(undefined, { USER: "login", USERNAME: "winlogin" }, "")._unsafeUnwrap()).toBe("login");
    expect(whoFrom(" ", { USERNAME: "winlogin" }, undefined)._unsafeUnwrap()).toBe("winlogin");
    const nobody = whoFrom(undefined, { USER: " " }, undefined)._unsafeUnwrapErr();
    expect([nobody.code, nobody.message]).toEqual(["USAGE", "say who you are: --by <name>"]);
    expect(nobody.hint).toContain("login name");
  });

  test("--by: a default said in the help, required for an approval, bare where the command decides", () => {
    const [plain, required, explicit] = [
      byOption("who answers"),
      byOption("who approved", "required"),
      byOption("who decided", "explicit"),
    ];
    expect([plain.flags, plain.description, plain.mandatory]).toEqual([
      "--by <name>",
      `who answers${BY_DEFAULT}`,
      false,
    ]);
    expect([required.description, required.mandatory]).toEqual(["who approved", true]);
    expect([explicit.description, explicit.mandatory]).toEqual(["who decided", false]);
  });

  test("--run and --base are spelled once", () => {
    expect([runOption().flags, runOption().description]).toEqual(["--run <id>", "run id (default: latest)"]);
    expect(runOption("only this run").description).toBe("only this run");
    expect([
      baseOption("compare with").defaultValue,
      baseOption("compare with", "HEAD").defaultValue,
    ]).toEqual([undefined, "HEAD"]);
  });

  test("the run as a word or as --run: either, both when they agree, never two", () => {
    expect(runGiven(undefined, {})._unsafeUnwrap()).toBeUndefined();
    expect(runGiven("r1", {})._unsafeUnwrap()).toBe("r1");
    expect(runGiven(undefined, { run: "r2" })._unsafeUnwrap()).toBe("r2");
    expect(runGiven("r1", { run: "r1" })._unsafeUnwrap()).toBe("r1");
    const two = runGiven("r1", { run: "r2" })._unsafeUnwrapErr();
    expect([two.code, two.message]).toEqual(["USAGE", "two runs named: r1 and --run r2"]);
  });

  test("defined drops what was not given and keeps false and 0", () => {
    const given: { a?: string; b?: string; c: boolean; d: number; e?: string } = {
      a: "x",
      b: "",
      c: false,
      d: 0,
    };
    expect(defined(given)).toEqual({ a: "x", c: false, d: 0 });
  });

  test("failWhen: the report, or CHECK_FAILED carrying it; the use case's own error passes through", () => {
    const report = ok({ problems: 2, files: ["a"] });
    expect(failWhen(report, () => undefined)).toEqual({ result: report });
    const failed = failWhen(
      report,
      (r) => r.problems > 0 && { message: `${r.problems} problem(s)`, hint: "fix them" },
      (r) => r.files.map((f) => `${f}: look`),
    );
    const e = failed.result._unsafeUnwrapErr();
    expect([e.code, e.message, e.hint, e.details]).toEqual([
      "CHECK_FAILED",
      "2 problem(s)",
      "fix them",
      { problems: 2, files: ["a"] },
    ]);
    expect(failed.warnings).toEqual(["a: look"]);
    const broken = err(MetatorError.notFound("the map"));
    expect(failWhen(broken, () => ({ message: "never" }))).toEqual({ result: broken });
  });
});
