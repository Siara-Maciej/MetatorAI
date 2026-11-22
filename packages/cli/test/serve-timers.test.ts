import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { intervalOf, startTimers } from "../src/serve/timers.ts";

/** A repository's container as the timers read it: its config, nothing else is called here. */
const repo = (everyMs: number, rules = 1, sources = 0, watch = false) =>
  ({
    resolve: (name: string) => {
      if (name !== "config") throw new Error(`unexpected ${name}`);
      return {
        config: {
          intake: { everyMs, rules: Array.from({ length: rules }, () => ({})) },
          reviews: { everyMs: everyMs * 10 },
          codehost: {
            sources: Array.from({ length: sources }, () => ({ kind: "github", repo: "a/b", via: "gh" })),
            review: { watch, everyMs: everyMs * 20 },
          },
        },
      };
    },
  }) as unknown as MetatorContainer;

const real = globalThis.setInterval;
afterEach(() => {
  globalThis.setInterval = real;
});

/** The intervals the timers set, without running any of them. */
function intervals(deps: Parameters<typeof startTimers>[0]): number[] {
  const set: number[] = [];
  globalThis.setInterval = ((_fn: () => void, ms: number) => {
    set.push(ms);
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  startTimers(deps).stop();
  return set;
}

describe("the daemon's clocks, per repository (a folder's repositories each keep their own)", () => {
  const repos = new Map([
    ["shop-api", repo(4000)],
    ["shop-web", repo(9000, 1, 1)],
    ["docs", repo(1000, 0)],
  ]);
  const deps = {
    repos: () => [...repos.keys()],
    containerFor: (name: string | undefined) => ok(repos.get(name as string) as MetatorContainer),
    superviseMs: 0,
  };

  test("each repository scans its intake on its own intake.everyMs; one without rules is not scanned", () => {
    expect(intervals({ ...deps, intakeMs: "own", reviewsMs: 0 })).toEqual([4000, 9000]);
    expect(intervals({ ...deps, intakeMs: 0, reviewsMs: "own" })).toEqual([90_000]);
  });

  test("an interval given to the daemon (--intake-ms) is every repository's", () => {
    expect(intervals({ ...deps, intakeMs: 5000, reviewsMs: 0 })).toEqual([5000, 5000]);
    expect([intervalOf("own", 7), intervalOf(3, 7)]).toEqual([7, 3]);
  });

  test("watched MRs (ADR-0097) on each repository's codehost.review.everyMs, only where watching is on", () => {
    const watching = new Map([
      ["a", repo(1000, 0, 0, true)],
      ["b", repo(2000, 0, 0, false)],
    ]);
    const w = {
      ...deps,
      repos: () => [...watching.keys()],
      containerFor: (n: string | undefined) => ok(watching.get(n as string) as MetatorContainer),
    };
    expect(intervals({ ...w, intakeMs: 0, reviewsMs: 0, watchMs: "own" })).toEqual([20_000]);
    expect(intervals({ ...w, intakeMs: 0, reviewsMs: 0, watchMs: 0 })).toEqual([]);
    expect(intervals({ ...w, intakeMs: 0, reviewsMs: 0, watchMs: 500 })).toEqual([500]);
  });

  test("finished runs' panes are swept on their own clock", () => {
    expect(intervals({ ...deps, intakeMs: 0, reviewsMs: 0, sweepMs: 2000 })).toEqual([2000]);
  });
});
