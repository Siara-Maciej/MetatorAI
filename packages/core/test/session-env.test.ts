import { describe, expect, test } from "bun:test";
import { isUuid, sessionEnv } from "../src/domain/drive.ts";

describe("sessionEnv", () => {
  test("names the run and its directory for the hooks, and that the drive carries the session", () => {
    expect(sessionEnv({ runDir: "/w/.metator/runs/20261102-mt-feature-a/", driven: true })).toEqual({
      METATOR_RUN: "20261102-mt-feature-a",
      METATOR_RUN_DIR: "/w/.metator/runs/20261102-mt-feature-a/",
      METATOR_DRIVEN: "1",
    });
  });

  test("keeps the base environment without its undefined values; an undriven session has no METATOR_DRIVEN", () => {
    const env = sessionEnv({ runDir: "C:\\w\\.metator\\runs\\r1" }, { PATH: "/bin", HOME: undefined });
    expect(env).toEqual({ PATH: "/bin", METATOR_RUN: "r1", METATOR_RUN_DIR: "C:\\w\\.metator\\runs\\r1" });
  });
});

describe("isUuid", () => {
  test("a UUID is one; a sentinel or a host's own id is not", () => {
    expect(["0b7a9c2e-3d4f-4a5b-8c6d-7e8f9a0b1c2d", "continue", "ses_abc", "0b7a9c2e"].map(isUuid)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});
