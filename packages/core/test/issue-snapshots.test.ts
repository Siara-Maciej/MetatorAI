import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { IssueSnapshots } from "../src/application/issue-snapshots.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

function world(head: string | null = "c1") {
  const fs = new InMemoryFileSystem({
    "packages/core/src/price.ts": "export const round = 1;\n",
    "packages/core/src/wip.ts": "draft\n",
    "packages/web/src/app.ts": "app\n",
  });
  const clock = new FixedClock(new Date("2026-11-22T09:00:00.000Z"));
  const vcs = { changed: ["packages/core/src/wip.ts"] as string[], fails: false };
  const snapshots = new IssueSnapshots({
    fs,
    hasher: { sha256: (t) => `h(${t.trim()})` },
    vcs: {
      changedFiles: async () => (vcs.fails ? err(MetatorError.usage("Unknown base ref")) : ok(vcs.changed)),
    },
    head: async () => ok(head ?? undefined),
    workspace: {
      packages: async () =>
        ok([
          { name: "@shop/core", dir: "packages/core" },
          { name: "@shop/web", dir: "packages/web" },
        ]),
    },
    clock,
    staleDays: async () => 14,
  });
  return { fs, clock, vcs, snapshots };
}

describe("IssueSnapshots", () => {
  test("take: the commit, each cited file that exists hashed, its packages, and what of them had changed then", async () => {
    const w = world();
    const s = (
      await w.snapshots.take(".metator/issues/i001/analysis.md", [
        "packages/core/src/price.ts",
        "src/missing.ts",
      ])
    )._unsafeUnwrap();
    expect(s).toEqual({
      file: ".metator/issues/i001/analysis.md",
      at: "2026-11-22T09:00:00.000Z",
      commit: "c1",
      cites: [{ path: "packages/core/src/price.ts", sha256: "h(export const round = 1;)" }],
      packages: ["@shop/core"],
      dirty: [{ path: "packages/core/src/wip.ts", sha256: "h(draft)" }],
    });
  });

  test("no commit yet: refused, with the step that fixes it", async () => {
    const w = world(null);
    expect((await w.snapshots.take("a.md", []))._unsafeUnwrapErr().message).toBe(
      "the repository has no commit yet: an analysis is made against a commit",
    );
  });

  test("freshness reads the checkout now: an edit of a cited file makes it stale, a change elsewhere does not", async () => {
    const w = world();
    const s = (await w.snapshots.take("a.md", ["packages/core/src/price.ts"]))._unsafeUnwrap();
    w.vcs.changed = ["packages/core/src/wip.ts", "packages/web/src/app.ts"];
    expect((await w.snapshots.freshness(s))._unsafeUnwrap()).toEqual({ state: "fresh" });
    await w.fs.write("packages/core/src/price.ts", "export const round = 2;\n");
    w.vcs.changed = [...w.vcs.changed, "packages/core/src/price.ts"];
    expect((await w.snapshots.freshness(s))._unsafeUnwrap()).toEqual({
      state: "stale",
      changed: ["packages/core/src/price.ts"],
    });
    // A commit this checkout cannot compare to: the hashes still decide.
    w.vcs.fails = true;
    expect((await w.snapshots.freshness(s))._unsafeUnwrap().state).toBe("stale");
    w.clock.advance(30 * 86_400_000);
    await w.fs.write("packages/core/src/price.ts", "export const round = 1;\n");
    expect((await w.snapshots.freshness(s))._unsafeUnwrap()).toEqual({ state: "old", days: 30 });
  });
});
