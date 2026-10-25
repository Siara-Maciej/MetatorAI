/** `metator changed` end to end against a real git repository. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("src/a.ts", "a");
  await repo.write("src/b.ts", "b");
  await repo.write(".gitignore", "dist/\n.metator/\n");
  await repo.commit("init");
  await repo.git("checkout", "-q", "-b", "feature");
  await repo.write("src/feature.ts", "f");
  await repo.commit("feature");
  await repo.write("src/a.ts", "a changed");
  await repo.write("src/new file ł.ts", "n");
  await repo.write("dist/build.js", "ignored");
});

afterAll(async () => {
  await repo.dispose();
});

describe("metator changed", () => {
  test("default base HEAD: working tree changes only", async () => {
    const r = await metator(["changed"], repo.root);
    expect(r.code).toBe(0);
    expect(r.json.data).toEqual({ base: "HEAD", files: ["src/a.ts", "src/new file ł.ts"] });
  });

  test("--base main: includes commits on the branch", async () => {
    const r = await metator(["changed", "--base", "main"], repo.root);
    expect(r.json.data).toEqual({ base: "main", files: ["src/a.ts", "src/feature.ts", "src/new file ł.ts"] });
  });

  test("unknown base is a usage error", async () => {
    const r = await metator(["changed", "--base", "does-not-exist"], repo.root);
    expect(r.code).toBe(64);
  });
});
