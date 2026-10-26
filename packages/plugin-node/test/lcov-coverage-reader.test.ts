import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LcovCoverageReader } from "../src/lcov-coverage-reader.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("LcovCoverageReader (real lcov-parser)", () => {
  test("line hits per repo-relative file; absolute paths and repeated sections merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-lcov-"));
    dirs.push(root);
    await Bun.write(
      join(root, "coverage/lcov.info"),
      `TN:\nSF:src/a.ts\nDA:1,2\nDA:2,2\nend_of_record\nTN:\nSF:${root}/src/a.ts\nDA:2,1\nend_of_record\nTN:\nSF:src/b.ts\nDA:5,0\nend_of_record\n`,
    );
    const hits = (await new LcovCoverageReader(root).read("coverage/lcov.info"))._unsafeUnwrap();
    expect([...hits.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect([...(hits.get("src/a.ts") ?? [])]).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  test("a missing report says how to make one", async () => {
    const e = (await new LcovCoverageReader(tmpdir()).read("nope/lcov.info"))._unsafeUnwrapErr();
    expect([e.code, e.hint]).toEqual(["NOT_FOUND", expect.stringContaining("--coverage-reporter=lcov")]);
  });
});
