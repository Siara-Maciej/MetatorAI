import { describe, expect, test } from "bun:test";
import type { PaneAsk } from "../src/api.ts";
import {
  isPaneAsk,
  needsQueue,
  paneAskKey,
  paneAskOf,
  paneNeedsYou,
  parseRoute,
  routeHash,
} from "../src/model.ts";

const ask = (over: Partial<PaneAsk> = {}): PaneAsk => ({
  kind: "pane",
  repo: "shop-api",
  paneId: "w1:p1",
  label: "chat",
  role: "apps",
  host: "claude",
  question: {
    id: "p001",
    paneId: "w1:p1",
    source: "permission",
    agent: "chat",
    prompt: "Bash command: metator workflow list — This command requires approval",
    options: [{ label: "Yes" }, { label: "No" }, { label: "Attach and answer in the pane" }],
    askedAt: "2026-11-20T10:00:00.000Z",
  },
  ...over,
});

describe("a pane's question on Home (ADR-0091)", () => {
  test("a pane without a run that asks is a row of the queue: its prompt, its pane and repository; its own key", () => {
    const rows = needsQueue([], [], [], [ask()], Date.parse("2026-11-20T10:02:00.000Z"));
    expect(rows).toEqual([
      {
        key: "pane/shop-api/w1:p1/p001",
        kind: "pane",
        title: "Bash command: metator workflow list — This command requires approval",
        sub: "chat · shop-api · 2 min",
        runId: "",
        repo: "shop-api",
        pane: "w1:p1",
        hint: "The chat's host asks: answer it here, or attach and answer in the pane",
      },
    ]);
    const { repo: _one, ...single } = ask();
    expect(paneAskKey(single)).toBe("pane/w1:p1/p001");
    expect(isPaneAsk(rows[0] as never)).toBe(true);
    expect(paneAskOf([ask()], rows[0]?.key)).toEqual(ask());
    expect(paneAskOf([ask()], "shop-api/r1/q001")).toBeUndefined();
    // Its address on Home goes there and back whole, the pane id's colon included.
    const hash = routeHash({ screen: "inbox", pick: rows[0]?.key as string });
    expect(parseRoute(hash)).toEqual({ screen: "inbox", pick: "pane/shop-api/w1:p1/p001" });
  });

  test("a pane whose question waits needs you, in its repository only", () => {
    expect(paneNeedsYou({ id: "w1:p1", repo: "shop-api" }, [ask()])).toBe(true);
    expect(paneNeedsYou({ id: "w1:p1", repo: "shop-web" }, [ask()])).toBe(false);
    expect(paneNeedsYou({ id: "w1:p2", repo: "shop-api" }, [ask()])).toBe(false);
  });

  test("an agent of a run that asks in words: its row names the run's task and keeps the run", () => {
    const runs = [
      { runId: "20261120-web", repo: "shop-api", task: "Prices in the customer's currency" },
    ] as never;
    const rows = needsQueue(
      [],
      runs,
      [],
      [ask({ runId: "20261120-web", label: "mt-orchestrator" })],
      Date.parse("2026-11-20T10:02:00.000Z"),
    );
    expect([rows[0]?.runId, rows[0]?.sub]).toEqual([
      "20261120-web",
      "Prices in the customer's currency · mt-orchestrator · shop-api · 2 min",
    ]);
  });
});
