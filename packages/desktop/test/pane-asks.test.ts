import { describe, expect, test } from "bun:test";
import { quietHeading, quietInboxText } from "../src/features/inbox/model.ts";
import type { PaneAsk } from "../src/shared/api/api.ts";
import {
  answersInTerminal,
  askingPane,
  cardNeeds,
  isPaneAsk,
  needPlace,
  needsQueue,
  nextNeed,
  paneAskKey,
  paneNeedsYou,
  terminalKey,
} from "../src/shared/model/needs.ts";
import type { Route } from "../src/shared/model/route.ts";

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

  test("what a terminal asks has no card: it is answered where it is asked", () => {
    const [pane] = needsQueue([], [], [], [ask()]);
    const terminal = { key: terminalKey({ runId: "r1", repo: "shop-api" }), kind: "terminal" as const };
    const gate = { key: "shop-api/r1/q001", kind: "approval" as const };
    expect(answersInTerminal(pane as never)).toBe(true);
    expect(answersInTerminal(terminal)).toBe(true);
    expect(answersInTerminal(gate)).toBe(false);
    // A question the daemon read from a terminal and keeps in the run's inbox stays a card.
    expect(answersInTerminal({ key: "r1/q002", kind: "terminal" })).toBe(false);
    expect(cardNeeds([pane, terminal, gate] as never).map((n) => n.key)).toEqual(["shop-api/r1/q001"]);
  });

  test("a need's place: the chat that asks, else its run's pane, else the pane on Terminals; a card on Home", () => {
    const [pane] = needsQueue([], [], [], [ask()]);
    const chatOf = (id: string, repo: string | undefined) =>
      id === "w1:p1" && repo === "shop-api" ? "t7" : undefined;
    expect(needPlace(pane as never, chatOf)).toEqual({ screen: "thread", id: "t7" });
    // No chat holds the pane: it is shown on Terminals.
    expect(needPlace(pane as never)).toEqual({ screen: "grid", pane: "w1:p1" });
    // A run's pane: the run's Terminal tab on that pane, where the person takes the keyboard.
    const [ofRun] = needsQueue([], [], [], [ask({ runId: "r1" })]);
    expect(needPlace(ofRun as never)).toEqual({ screen: "run", runId: "r1", tab: "terminal", pane: "w1:p1" });
    expect(
      needPlace({
        key: "terminal:shop-api:r1",
        kind: "terminal",
        runId: "r1",
        repo: "shop-api",
        pane: "w1:p2",
      }),
    ).toEqual({ screen: "run", runId: "r1", tab: "terminal", pane: "w1:p2" });
    expect(
      needPlace({ key: "terminal::r1", kind: "terminal", runId: "r1", repo: undefined, pane: undefined }),
    ).toEqual({ screen: "run", runId: "r1", tab: "terminal" });
    expect(
      needPlace(
        { key: "shop-api/r1/q001", kind: "approval", runId: "r1", repo: "shop-api", pane: undefined },
        chatOf,
      ),
    ).toEqual({ screen: "inbox", pick: "shop-api/r1/q001" });
  });

  test("Needs you goes to the first that waits, then to the one after the one on screen, around the end", () => {
    const places: Record<string, Route> = {
      a: { screen: "thread", id: "t1" },
      b: { screen: "grid", pane: "w1:p3" },
      c: { screen: "inbox", pick: "r1/q001" },
    };
    const placeOf = (n: string) => places[n] as Route;
    const rows = ["a", "b", "c"];
    expect(nextNeed(rows, { screen: "board" }, placeOf)).toBe("a");
    expect(nextNeed(rows, { screen: "thread", id: "t1" }, placeOf)).toBe("b");
    expect(nextNeed(rows, { screen: "grid", pane: "w1:p3" }, placeOf)).toBe("c");
    expect(nextNeed(rows, { screen: "inbox", pick: "r1/q001" }, placeOf)).toBe("a");
    // The only one, already on screen: it stays the one.
    expect(nextNeed(["a"], { screen: "thread", id: "t1" }, placeOf)).toBe("a");
    expect(nextNeed([], { screen: "inbox" }, placeOf)).toBeUndefined();
  });

  test("a run's pane that waits for a typed answer: the one the run names, else its pane that asks", () => {
    const run = { runId: "r1", repo: "shop-api", terminalAsk: undefined };
    expect(askingPane(run, [ask({ runId: "r1" })])).toBe("w1:p1");
    expect(askingPane({ ...run, terminalAsk: "w1:p4" }, [ask({ runId: "r1" })])).toBe("w1:p4");
    // Another run's pane, the same run id in another repository, a pane without a run: not this run's.
    expect(askingPane(run, [ask({ runId: "r2" }), ask()])).toBeUndefined();
    expect(askingPane({ ...run, repo: "shop-web" }, [ask({ runId: "r1" })])).toBeUndefined();
  });

  test("Home never says nothing waits while a terminal asks", () => {
    expect(quietHeading(0, 0, 1)).toBe("No decision waits for you");
    expect(quietInboxText(2, 0, 0, 1)).toBe(
      "1 terminal waits for your answer: open it above and answer there.",
    );
    expect(quietInboxText(2, 1, 0, 2)).toBe(
      "2 terminals wait for your answer: open one above and answer there.",
    );
  });
});
