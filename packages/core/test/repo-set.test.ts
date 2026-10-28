import { describe, expect, test } from "bun:test";
import { proposeRepoSet, RepoSetDocument, reposOf } from "../src/domain/repo-set.ts";

describe("RepoSet", () => {
  test("names come from the last part of the path; clashing names get the whole path", () => {
    expect(proposeRepoSet(["web", "services/billing", "billing", "web"])).toEqual({
      repos: [
        { path: "billing", name: "billing" },
        { path: "services/billing", name: "services-billing" },
        { path: "web" },
      ],
    });
    expect(reposOf(proposeRepoSet(["a/x/", "b"])).repos).toEqual([
      { name: "x", path: "a/x" },
      { name: "b", path: "b" },
    ]);
  });

  test("two repositories with one name are a problem; paths stay inside the folder", () => {
    const set = { repos: [{ path: "a/api" }, { path: "b/api" }] };
    expect(reposOf(set).problems).toEqual(["two repositories are named api; give one of them a `name`"]);
    for (const path of ["/abs", "../up", "a/../b"]) {
      const r = RepoSetDocument.parse({ kind: "RepoSet", schemaVersion: 1, repos: [{ path }] }, "f");
      expect(r._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    }
    expect(RepoSetDocument.parse({ kind: "RepoSet", schemaVersion: 1, repos: [] }, "f").isErr()).toBe(true);
  });
});
