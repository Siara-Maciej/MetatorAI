import { describe, expect, test } from "bun:test";
import { type AttachIo, type AttachSocket, attachPane, DETACH_KEY, isPaneId } from "../src/attach.ts";

/** A fake terminal: what was written, keys and resizes pushed from the test, raw mode tracked. */
function fakeIo() {
  const out: string[] = [];
  let keys: ((d: string) => void) | undefined;
  let resized: (() => void) | undefined;
  const raw: boolean[] = [];
  let size = { cols: 100, rows: 30 };
  const io: AttachIo = {
    write: (t) => {
      out.push(t);
    },
    onKey: (l) => {
      keys = l;
      return () => {
        keys = undefined;
      };
    },
    onResize: (l) => {
      resized = l;
      return () => {
        resized = undefined;
      };
    },
    size: () => size,
    setRaw: (on) => {
      raw.push(on);
    },
  };
  return {
    io,
    out,
    raw,
    key: (d: string) => keys?.(d),
    resize: (cols: number, rows: number) => {
      size = { cols, rows };
      resized?.();
    },
    listening: () => keys !== undefined,
  };
}

/** A fake pane socket: what the client sent, events pushed from the test. */
function fakeSocket() {
  const sent: string[] = [];
  let open: (() => void) | undefined;
  let message: ((t: string) => void) | undefined;
  let close: (() => void) | undefined;
  let closed = false;
  const socket: AttachSocket = {
    send: (t) => {
      sent.push(t);
    },
    close: () => {
      closed = true;
    },
    onOpen: (l) => {
      open = l;
    },
    onMessage: (l) => {
      message = l;
    },
    onClose: (l) => {
      close = l;
    },
  };
  return {
    socket,
    sent,
    isClosed: () => closed,
    connect: () => {
      queueMicrotask(() => open?.());
      return socket;
    },
    emit: (e: unknown) => message?.(JSON.stringify(e)),
    drop: () => close?.(),
  };
}

describe("attachPane", () => {
  test("goes raw on the session, forwards keys and resizes, shows the pane's bytes and refusals; Ctrl-] detaches", async () => {
    const t = fakeIo();
    const s = fakeSocket();
    const done = attachPane({ paneId: "w1:p2", io: t.io, connect: s.connect });
    await Bun.sleep(1);
    expect(JSON.parse(s.sent[0] as string)).toEqual({ type: "resize", cols: 100, rows: 30 });
    s.emit({ type: "session", session: { alive: true, role: "worker", runId: "r1" } });
    expect(t.raw).toEqual([true]);
    expect(t.out[0]).toContain("attached to w1:p2 (worker of run r1); detach: Ctrl-]");
    s.emit({ type: "data", data: "hello\r\n" });
    expect(t.out.at(-1)).toBe("hello\r\n");
    t.key("y");
    t.key("\r");
    expect(s.sent.slice(1).map((m) => JSON.parse(m))).toEqual([
      { type: "input", data: "y" },
      { type: "input", data: "\r" },
    ]);
    t.resize(80, 24);
    expect(JSON.parse(s.sent.at(-1) as string)).toEqual({ type: "resize", cols: 80, rows: 24 });
    s.emit({ type: "refused", reason: "run r1 is driven by the agent: attach first" });
    s.emit({ type: "refused", reason: "run r1 is driven by the agent: attach first" });
    expect(t.out.at(-1)).toContain("[metator: run r1 is driven by the agent: attach first]");
    // Keys before the prefix still go through; the prefix ends it and the terminal is restored.
    t.key(`ab${DETACH_KEY}cd`);
    const outcome = (await done)._unsafeUnwrap();
    expect(outcome).toEqual({
      paneId: "w1:p2",
      ended: "detached",
      refused: ["run r1 is driven by the agent: attach first"],
    });
    expect(JSON.parse(s.sent.at(-1) as string)).toEqual({ type: "input", data: "ab" });
    expect([t.raw, s.isClosed(), t.listening()]).toEqual([[true, false], true, false]);
    expect(t.out.at(-1)).toContain("detached from w1:p2; the pane goes on");
  });

  test("the pane's exit ends it with the code; a dropped socket ends it as closed; the daemon's error is an error", async () => {
    const a = fakeIo();
    const sa = fakeSocket();
    const exit = attachPane({ paneId: "w1:p1", io: a.io, connect: sa.connect });
    sa.emit({ type: "session", session: { alive: true, role: "shell" } });
    expect(a.out[0]).toContain("attached to w1:p1 (shell)");
    sa.emit({ type: "exit", code: 3 });
    expect((await exit)._unsafeUnwrap()).toEqual({
      paneId: "w1:p1",
      ended: "exited",
      exitCode: 3,
      refused: [],
    });
    expect(a.out.at(-1)).toContain("pane w1:p1 exited with 3");
    const b = fakeIo();
    const sb = fakeSocket();
    const dropped = attachPane({ paneId: "w1:p1", io: b.io, connect: sb.connect });
    sb.drop();
    expect((await dropped)._unsafeUnwrap().ended).toBe("closed");
    const c = fakeIo();
    const sc = fakeSocket();
    const refusedToOpen = attachPane({ paneId: "w9:p9", io: c.io, connect: sc.connect });
    sc.emit({ type: "error", error: { message: "a terminal in pane w9:p9 was not found" } });
    expect((await refusedToOpen)._unsafeUnwrapErr().message).toBe("a terminal in pane w9:p9 was not found");
    expect(c.raw).toEqual([false]);
    // Junk on the socket is ignored.
    const d = fakeIo();
    const sd = fakeSocket();
    const junk = attachPane({ paneId: "w1:p1", io: d.io, connect: sd.connect });
    sd.socket.send("x");
    (sd as unknown as { emit: (e: unknown) => void }).emit;
    sd.drop();
    expect((await junk).isOk()).toBe(true);
  });

  test("a pane id is w<n>:p<n>; anything else names a run", () => {
    expect(["w1:p2", "w12:p345", "r1", "20261109-demo-x", "w1p2", "w1:p"].map(isPaneId)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
