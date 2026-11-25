import { describe, expect, test } from "bun:test";
import { flattenState, folderLabel, placeLabel, worktreeCount } from "../src/shared/model/places.ts";

/** A folder the daemon serves: shop with two worktrees, billing and web. */
const places = [
  { name: "billing", path: "billing" },
  { name: "shop", path: "shop" },
  { name: "shop-fix", path: "shop-fix", worktreeOf: "shop", branch: "fix-tax" },
  { name: "shop-wip", path: "shop-wip", worktreeOf: "shop" },
  { name: "web", path: "web" },
];

describe("a folder's worktrees in the app", () => {
  test("the folder counts repositories, not checkouts; each one with worktrees says how many", () => {
    expect(folderLabel(places)).toEqual({
      text: "3 repositories",
      repos: ["billing", "shop · 2 worktrees", "web"],
    });
    expect(folderLabel([{ name: "a", path: "a" }]).text).toBe("1 repository");
    expect(folderLabel([]).text).toBe("this repository");
  });

  test("a picker names a worktree by its repository and branch, else its directory", () => {
    expect(places.map(placeLabel)).toEqual(["billing", "shop", "shop (fix-tax)", "shop (shop-wip)", "web"]);
  });

  test("the worktrees of the chosen place's repository, from the repository or any of its worktrees", () => {
    expect([
      worktreeCount(places, "shop"),
      worktreeCount(places, "shop-fix"),
      worktreeCount(places, "web"),
    ]).toEqual([2, 2, 0]);
    expect(worktreeCount(places, undefined)).toBe(0);
  });

  test("the state keeps what the daemon says of a worktree; its runs are its own place's", () => {
    const flat = flattenState({
      folder: "/w",
      repos: [
        { name: "shop", path: "shop", runs: [] },
        { name: "shop-fix", path: "shop-fix", worktreeOf: "shop", branch: "fix-tax", runs: [] },
      ],
    });
    expect(flat.repos).toEqual([
      { name: "shop", path: "shop" },
      { name: "shop-fix", path: "shop-fix", worktreeOf: "shop", branch: "fix-tax" },
    ]);
  });
});
