/**
 * The daemon's push channel as the app reads it (src/shared/api/events.ts, ADR-0110): a message is
 * checked before it is believed; a change right after the last one reads its topics again, a gap
 * or another daemon reads everything; a polled request knows its topic.
 */
import { describe, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { NO_CHANNEL, readEvent, topicBase, topicOfKey } from "../src/shared/api/events.ts";
import { createQueryClient, intervalOf, polledOptions, readAgain } from "../src/shared/api/query.ts";

describe("a message of the channel", () => {
  test("hello from a new daemon reads everything; the same daemon caught up reads nothing", () => {
    const first = readEvent(NO_CHANNEL, { type: "hello", epoch: "e1", seq: 0 });
    expect(first).toEqual({ channel: { epoch: "e1", seq: 0 }, read: "all" });
    expect(readEvent(first.channel, { type: "hello", epoch: "e1", seq: 0 }).read).toEqual([]);
    // Back after a drop, with messages sent meanwhile: everything is read again.
    expect(readEvent(first.channel, { type: "hello", epoch: "e1", seq: 4 }).read).toBe("all");
    expect(readEvent(first.channel, { type: "hello", epoch: "e2", seq: 0 }).read).toBe("all");
  });

  test("the next change reads its topics, without their run or repository, once each", () => {
    const r = readEvent(
      { epoch: "e1", seq: 3 },
      {
        type: "changed",
        epoch: "e1",
        seq: 4,
        topics: ["layout@shop", "activity:r1", "activity:r2", "state"],
      },
    );
    expect(r.channel).toEqual({ epoch: "e1", seq: 4 });
    expect(r.read).toEqual(["layout", "activity", "state"]);
  });

  test("a gap, or a change from another daemon, reads everything", () => {
    expect(
      readEvent({ epoch: "e1", seq: 3 }, { type: "changed", epoch: "e1", seq: 6, topics: ["state"] }).read,
    ).toBe("all");
    expect(
      readEvent({ epoch: "e1", seq: 3 }, { type: "changed", epoch: "e2", seq: 4, topics: ["state"] }).read,
    ).toBe("all");
  });

  test("what is not a message changes nothing", () => {
    const channel = { epoch: "e1", seq: 3 };
    for (const raw of [
      null,
      "x",
      { type: "changed", epoch: "e1", seq: 4 },
      { type: "other", epoch: "e1", seq: 4 },
    ])
      expect(readEvent(channel, raw)).toEqual({ channel, read: [] });
  });

  test("a topic's base", () => {
    expect(topicBase("activity:r1@shop")).toBe("activity");
    expect(topicBase("layout@web")).toBe("layout");
    expect(topicBase("state")).toBe("state");
  });
});

describe("a polled request and the channel", () => {
  test("its key names its topic; an unknown one is read again with the state", () => {
    expect(topicOfKey("layout:shop\nweb")).toBe("layout");
    expect(topicOfKey("system-plans:shop")).toBe("plans");
    expect(topicOfKey("card-plan:shop:r1:q1")).toBe("plans");
    expect(topicOfKey("mrs:shop")).toBe("reviews");
    expect(topicOfKey("issue-detail:shop:i1")).toBe("backlog");
    expect(topicOfKey("threads")).toBe("threads");
    expect(topicOfKey("overview:shop:r1")).toBe("state");
    expect([...polledOptions("http://d", "mrs:shop", async () => ({ ok: true }), 0).queryKey]).toEqual([
      "polled",
      "http://d",
      "reviews",
      "mrs:shop",
    ]);
  });

  test("while the channel is live, a topic the daemon sweeps is asked only as a fallback", () => {
    expect(intervalOf(1000, false, "layout")).toBe(1000);
    expect(intervalOf(1000, true, "layout")).toBe(30_000);
    expect(intervalOf(5000, true, "threads")).toBe(50_000);
    // Another process can change the backlog without the daemon saying so: it keeps its interval.
    expect(intervalOf(2000, true, "backlog")).toBe(2000);
    expect(intervalOf(0, true, "layout")).toBe(false);
  });

  test("a change reads again the queries of its topics, of this daemon only", async () => {
    const client = createQueryClient();
    let asked = { layout: 0, reviews: 0, other: 0 };
    const watch = (scope: string, key: string, count: keyof typeof asked) =>
      new QueryObserver(
        client,
        polledOptions(
          scope,
          key,
          async () => {
            asked = { ...asked, [count]: asked[count] + 1 };
            return { ok: true, data: 1 };
          },
          0,
        ),
      ).subscribe(() => {});
    const stops = [
      watch("http://d", "layout:shop", "layout"),
      watch("http://d", "mrs:shop", "reviews"),
      watch("http://e", "layout:shop", "other"),
    ];
    await Bun.sleep(10);
    asked = { layout: 0, reviews: 0, other: 0 };
    await readAgain(client, "http://d", ["layout"]);
    expect(asked).toEqual({ layout: 1, reviews: 0, other: 0 });
    await readAgain(client, "http://d", []);
    expect(asked).toEqual({ layout: 1, reviews: 0, other: 0 });
    await readAgain(client, "http://d", "all");
    expect(asked).toEqual({ layout: 2, reviews: 1, other: 0 });
    for (const stop of stops) stop();
    client.clear();
  });
});
