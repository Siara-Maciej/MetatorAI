import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrControlContract, standInHerdr } from "@metator/testing";
import { HerdrCli, herdrError, METADATA_SOURCE } from "../src/herdr-cli.ts";

const fresh = () => standInHerdr(mkdtempSync(join(tmpdir(), "metator-herdr-")));

herdrControlContract("HerdrCli", async () => {
  const herdr = fresh();
  return { control: new HerdrCli(herdr.bin), setAgentStatus: herdr.setAgentStatus };
});

describe("HerdrCli", () => {
  test("the CLI calls it makes are the ones herdr documents", async () => {
    const herdr = fresh();
    const cli = new HerdrCli(herdr.bin);
    const { workspace, pane } = (
      await cli.open({
        cwd: "/repo/.metator/wt/x",
        label: "x",
        env: { METATOR_RUN: "x", METATOR_DRIVEN: "1" },
      })
    )._unsafeUnwrap();
    await cli.run(pane, "claude 'Add discount' --session-id 1");
    await cli.report(pane, { title: "build · working", tokens: { run: "x", waiting: "0" } });
    await cli.status(pane);
    await cli.close(workspace);
    expect(herdr.calls()).toEqual([
      [
        "workspace",
        "create",
        "--cwd",
        "/repo/.metator/wt/x",
        "--label",
        "x",
        "--no-focus",
        "--env",
        "METATOR_RUN=x",
        "--env",
        "METATOR_DRIVEN=1",
      ],
      ["pane", "run", "w1:p1", "claude 'Add discount' --session-id 1"],
      [
        "pane",
        "report-metadata",
        "w1:p1",
        "--source",
        METADATA_SOURCE,
        "--title",
        "build · working",
        "--token",
        "run=x",
        "--token",
        "waiting=0",
      ],
      ["pane", "get", "w1:p1"],
      ["workspace", "close", "w1"],
    ]);
  });

  test("herdr's own error code and message reach the error; a missing binary says how to fix it", async () => {
    const herdr = fresh();
    const failed = await new HerdrCli(herdr.bin).close("w42");
    expect(failed._unsafeUnwrapErr().message).toBe(
      "herdr workspace close failed: workspace_not_found: workspace w42 not found",
    );
    const missing = await new HerdrCli("/nonexistent/herdr").status("w1:p1");
    expect(missing._unsafeUnwrapErr().hint).toContain("METATOR_HERDR_BIN");
  });

  test("herdrError reads herdr's JSON error line, and nothing else", () => {
    expect(herdrError('noise\n{"error":{"code":"timeout","message":"slow"}}')).toEqual({
      code: "timeout",
      message: "slow",
    });
    expect(herdrError("plain text")).toBeUndefined();
  });
});
