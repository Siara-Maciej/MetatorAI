import { describe, expect, test } from "bun:test";
import { CheckPublished } from "../src/application/runs.ts";
import { type PublishedBranch, publicationProblem } from "../src/domain/publication.ts";
import { ok } from "../src/domain/result.ts";

const branch = (over: Partial<PublishedBranch> = {}): PublishedBranch => ({
  branch: "metator/r",
  head: "a1b2c3d4e5",
  remote: "a1b2c3d4e5",
  uncommitted: [],
  ...over,
});

describe("publicationProblem", () => {
  test("published: nothing uncommitted and origin's branch at the checked-out commit", () => {
    expect(publicationProblem(branch())).toBeUndefined();
  });
  test("uncommitted work, a branch origin lacks, or one behind: each says what to do", () => {
    expect(publicationProblem(branch({ uncommitted: ["src/a.ts"] }))).toBe(
      "not committed: src/a.ts (git add -A, then git commit)",
    );
    expect(publicationProblem(branch({ remote: null }))).toBe(
      "origin has no branch metator/r: git push -u origin metator/r",
    );
    expect(publicationProblem(branch({ remote: "f0f0f0f0f0" }))).toBe(
      "origin's metator/r is at f0f0f0f, the branch at a1b2c3d: push again",
    );
    const many = branch({ uncommitted: ["a", "b", "c", "d", "e", "f"] });
    expect(publicationProblem(many)).toBe("not committed: a, b, c, d, e, … (git add -A, then git commit)");
  });
});

describe("CheckPublished", () => {
  test("an error value that names the problem until the branch is published", async () => {
    const check = (state: PublishedBranch) =>
      new CheckPublished({ published: async () => ok(state) }).execute();
    expect((await check(branch()))._unsafeUnwrap().branch).toBe("metator/r");
    const failed = (await check(branch({ remote: null })))._unsafeUnwrapErr();
    expect([failed.code, failed.message]).toEqual([
      "CHECK_FAILED",
      "not published: origin has no branch metator/r: git push -u origin metator/r",
    ]);
  });
});
